import { Router, type IRouter, type Response } from "express";
import { eq, and, desc, asc, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  db,
  quizzesTable,
  quizQuestionsTable,
  quizAttemptsTable,
  quizSessionsTable,
  usersTable,
  type Quiz,
  type QuizQuestion,
  type QuizAttempt,
  type QuizAnswer,
  type QuizSession,
  type QuizDraftAnswer,
  type User,
  type Course,
} from "@workspace/db";
import {
  ListQuizzesParams,
  ListQuizzesResponse,
  CreateQuizParams,
  CreateQuizBody,
  CreateQuizResponse,
  GetQuizParams,
  GetQuizResponse,
  UpdateQuizParams,
  UpdateQuizBody,
  UpdateQuizResponse,
  DeleteQuizParams,
  PublishQuizParams,
  PublishQuizResponse,
  PublishQuizResultsParams,
  PublishQuizResultsResponse,
  ListQuizAttemptsParams,
  ListQuizAttemptsResponse,
  CreateQuizAttemptParams,
  CreateQuizAttemptBody,
  CreateQuizAttemptResponse,
  GradeQuizAttemptParams,
  GradeQuizAttemptBody,
  GradeQuizAttemptResponse,
  StartQuizSessionParams,
  StartQuizSessionResponse,
  SaveQuizSessionParams,
  SaveQuizSessionBody,
  SaveQuizSessionResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getCourse, canAccessCourse, isCourseTeacher } from "../lib/authz";
import { gradeShortAnswer } from "../lib/grading";
import { logActivity } from "../lib/activityLog";
import { notifyCourseStudents, createNotifications } from "../lib/notifications";

const router: IRouter = Router();

type QuestionInput = {
  type: "multiple_choice" | "short_answer";
  prompt: string;
  options?: string[];
  correctOption?: number;
  points: number;
};

function validateQuestions(questions: QuestionInput[]): string | null {
  for (const q of questions) {
    if (q.type === "multiple_choice") {
      const options = q.options ?? [];
      if (options.length < 2) {
        return "Multiple-choice questions need at least two options";
      }
      if (
        q.correctOption == null ||
        q.correctOption < 0 ||
        q.correctOption >= options.length
      ) {
        return "Multiple-choice questions need a valid correct option";
      }
    }
  }
  return null;
}

function quizMaxScore(questions: QuizQuestion[]): number {
  return questions.reduce((sum, q) => sum + q.points, 0);
}

/** Strip correct answers for students. */
function sanitizeQuestions(
  questions: QuizQuestion[],
  revealAnswers: boolean,
): (QuizQuestion | (Omit<QuizQuestion, "correctOption"> & { correctOption: null }))[] {
  if (revealAnswers) return questions;
  return questions.map((q) => ({ ...q, correctOption: null }));
}

/** Strip scoring info from a student's own attempt until results are published. */
function sanitizeAttempt(attempt: QuizAttempt, revealScores: boolean): QuizAttempt {
  if (revealScores) return attempt;
  return {
    ...attempt,
    score: null,
    answers: attempt.answers.map((a) => ({
      questionId: a.questionId,
      selectedOption: a.selectedOption ?? null,
      textAnswer: a.textAnswer ?? null,
      autoScore: null,
      aiScore: null,
      aiFeedback: null,
      score: null,
    })),
  };
}

async function getQuizQuestions(quizId: number): Promise<QuizQuestion[]> {
  return db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId))
    .orderBy(asc(quizQuestionsTable.position), asc(quizQuestionsTable.id));
}

async function loadQuizWithCourse(quizId: number) {
  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, quizId));
  if (!quiz) return { quiz: undefined, course: undefined };
  const course = await getCourse(quiz.courseId);
  return { quiz, course };
}

async function insertQuestions(quizId: number, questions: QuestionInput[]) {
  await db.insert(quizQuestionsTable).values(
    questions.map((q, i) => ({
      quizId,
      position: i,
      type: q.type,
      prompt: q.prompt,
      options: q.type === "multiple_choice" ? (q.options ?? []) : [],
      correctOption: q.type === "multiple_choice" ? q.correctOption! : null,
      points: q.points,
    })),
  );
}

/* ---------------- Exam robustness: sessions, deadlines, auto-submit ---------------- */

/**
 * Slack after the deadline for requests that were sent in time but arrived
 * late (slow campus WiFi, a retry after a dropped connection).
 */
export const DEADLINE_GRACE_MS = 30_000;

/** The earlier of (start + time limit) and the quiz due date; null = no deadline. */
function computeDeadline(quiz: Quiz, startedAt: Date): Date | null {
  const candidates: number[] = [];
  if (quiz.timeLimitMinutes) {
    candidates.push(startedAt.getTime() + quiz.timeLimitMinutes * 60_000);
  }
  if (quiz.dueDate) candidates.push(quiz.dueDate.getTime());
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

function isPastDeadline(deadline: Date | null, now: Date): boolean {
  return !!deadline && now.getTime() > deadline.getTime() + DEADLINE_GRACE_MS;
}

function formatIst(d: Date): string {
  return `${d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST`;
}

/** An enrolled student of an active course (teachers preview, they don't sit quizzes). */
async function canTakeQuiz(course: Course, user: User): Promise<boolean> {
  return !isCourseTeacher(course, user) && (await canAccessCourse(course, user));
}

function serializeSession(s: QuizSession) {
  return {
    quizId: s.quizId,
    startedAt: s.startedAt,
    deadlineAt: s.deadlineAt,
    serverNow: new Date(),
    lastSavedAt: s.lastSavedAt,
    saveCount: s.saveCount,
    answers: s.answers,
  };
}

async function getSession(quizId: number, studentId: string): Promise<QuizSession | undefined> {
  const [session] = await db
    .select()
    .from(quizSessionsTable)
    .where(
      and(
        eq(quizSessionsTable.quizId, quizId),
        eq(quizSessionsTable.studentId, studentId),
      ),
    );
  return session;
}

/** Keep only the fields a student may send; drop answers to unknown questions. */
function cleanDraftAnswers(
  input: { questionId: number; selectedOption?: number | null; textAnswer?: string | null }[],
  questions: QuizQuestion[],
): QuizDraftAnswer[] {
  const ids = new Set(questions.map((q) => q.id));
  return input
    .filter((a) => ids.has(a.questionId))
    .map((a) => ({
      questionId: a.questionId,
      selectedOption: a.selectedOption ?? null,
      textAnswer: a.textAnswer ?? null,
    }));
}

/** Score every question: MC instantly, short answers via AI (best-effort). */
async function scoreAnswers(
  questions: QuizQuestion[],
  input: QuizDraftAnswer[],
): Promise<QuizAnswer[]> {
  const answerByQuestion = new Map(input.map((a) => [a.questionId, a]));
  return Promise.all(
    questions.map(async (q) => {
      const a = answerByQuestion.get(q.id);
      if (q.type === "multiple_choice") {
        const selected =
          a?.selectedOption != null &&
          a.selectedOption >= 0 &&
          a.selectedOption < q.options.length
            ? a.selectedOption
            : null;
        const autoScore =
          selected != null && selected === q.correctOption ? q.points : 0;
        return {
          questionId: q.id,
          selectedOption: selected,
          textAnswer: null,
          autoScore,
          aiScore: null,
          aiFeedback: null,
          score: null,
        };
      }
      const text = a?.textAnswer?.trim() ?? "";
      const graded = await gradeShortAnswer(q.prompt, q.points, text);
      return {
        questionId: q.id,
        selectedOption: null,
        textAnswer: text || null,
        autoScore: null,
        aiScore: graded.aiScore,
        aiFeedback: graded.aiFeedback,
        score: null,
      };
    }),
  );
}

/**
 * Turns a student's answers into their (single) attempt. Returns undefined
 * when an attempt already exists — the unique constraint makes this safe when
 * the student's own Submit races the server's auto-submit.
 */
async function insertAttempt(
  quiz: Quiz,
  studentId: string,
  questions: QuizQuestion[],
  draft: QuizDraftAnswer[],
  autoSubmitted: boolean,
): Promise<QuizAttempt | undefined> {
  const answers = await scoreAnswers(questions, draft);
  const [attempt] = await db
    .insert(quizAttemptsTable)
    .values({
      quizId: quiz.id,
      studentId,
      answers,
      score: null,
      maxScore: quizMaxScore(questions),
      status: "submitted",
      autoSubmitted,
    })
    .onConflictDoNothing()
    .returning();
  return attempt;
}

/** Submit a session's last auto-saved answers because its time ran out. */
async function autoSubmitSession(
  quiz: Quiz,
  session: QuizSession,
  questions?: QuizQuestion[],
): Promise<QuizAttempt | undefined> {
  const qs = questions ?? (await getQuizQuestions(quiz.id));
  const attempt = await insertAttempt(quiz, session.studentId, qs, session.answers, true);
  if (attempt) {
    void logActivity({
      user: null,
      action: "quiz.auto_submitted",
      message: `Time ran out on quiz "${quiz.title}"; submitted ${session.answers.length} saved answer(s) for student ${session.studentId}`,
      metadata: {
        quizId: quiz.id,
        attemptId: attempt.id,
        studentId: session.studentId,
        lastSavedAt: session.lastSavedAt?.toISOString() ?? null,
      },
    });
  }
  return attempt;
}

/**
 * Serverless-friendly sweep (no background timers): any session whose
 * deadline has passed without a submission is submitted now with its saved
 * answers. Runs whenever the quiz or its attempts are read, so the teacher
 * never sees a student "stuck" in progress after the exam ends.
 * `includeRunning` also submits sessions that still have time left — used
 * when results are published, which closes the quiz for everyone.
 */
async function autoSubmitDueSessions(
  quiz: Quiz,
  { includeRunning = false }: { includeRunning?: boolean } = {},
): Promise<void> {
  const cutoff = new Date(Date.now() - DEADLINE_GRACE_MS);
  const expired = await db
    .select()
    .from(quizSessionsTable)
    .where(
      includeRunning
        ? eq(quizSessionsTable.quizId, quiz.id)
        : and(
            eq(quizSessionsTable.quizId, quiz.id),
            isNotNull(quizSessionsTable.deadlineAt),
            lt(quizSessionsTable.deadlineAt, cutoff),
          ),
    );
  if (expired.length === 0) return;
  const submitted = await db
    .select({ studentId: quizAttemptsTable.studentId })
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.quizId, quiz.id));
  const done = new Set(submitted.map((a) => a.studentId));
  const pending = expired.filter((s) => !done.has(s.studentId));
  if (pending.length === 0) return;
  const questions = await getQuizQuestions(quiz.id);
  for (const session of pending) {
    await autoSubmitSession(quiz, session, questions);
  }
}

router.get(
  "/courses/:courseId/quizzes",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListQuizzesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const course = await getCourse(params.data.courseId);
    if (!course) {
      res.status(404).json({ error: "Course not found" });
      return;
    }
    if (!(await canAccessCourse(course, req.localUser!))) {
      res.status(403).json({ error: "Not a member of this course" });
      return;
    }
    const teacher = isCourseTeacher(course, req.localUser!);

    const quizzes = await db
      .select()
      .from(quizzesTable)
      .where(eq(quizzesTable.courseId, course.id))
      .orderBy(desc(quizzesTable.createdAt));

    const visible = teacher
      ? quizzes
      : quizzes.filter((q) => q.status === "published");

    const enriched = await Promise.all(
      visible.map(async (quiz) => {
        await autoSubmitDueSessions(quiz);
        const questions = await getQuizQuestions(quiz.id);
        const attempts = await db
          .select()
          .from(quizAttemptsTable)
          .where(eq(quizAttemptsTable.quizId, quiz.id));
        const mine = attempts.find((a) => a.studentId === req.userId!);
        return {
          ...quiz,
          maxScore: quizMaxScore(questions),
          questionCount: questions.length,
          attemptCount: attempts.length,
          myAttempt: mine
            ? sanitizeAttempt(mine, !!quiz.resultsPublishedAt)
            : null,
        };
      }),
    );

    res.json(ListQuizzesResponse.parse(enriched));
  },
);

router.post(
  "/courses/:courseId/quizzes",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateQuizParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateQuizBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const course = await getCourse(params.data.courseId);
    if (!course) {
      res.status(404).json({ error: "Course not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can create quizzes" });
      return;
    }
    const problem = validateQuestions(parsed.data.questions as QuestionInput[]);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    const [quiz] = await db
      .insert(quizzesTable)
      .values({
        courseId: course.id,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        timeLimitMinutes: parsed.data.timeLimitMinutes ?? null,
        status: "draft",
      })
      .returning();
    await insertQuestions(quiz.id, parsed.data.questions as QuestionInput[]);
    const questions = await getQuizQuestions(quiz.id);

    void logActivity({
      user: req.localUser!,
      action: "quiz.created",
      message: `${req.localUser!.email} created quiz "${quiz.title}" in course "${course.title}"`,
      metadata: { quizId: quiz.id, courseId: course.id },
    });

    res.status(201).json(
      CreateQuizResponse.parse({
        ...quiz,
        maxScore: quizMaxScore(questions),
        questionCount: questions.length,
        attemptCount: 0,
        questions,
        myAttempt: null,
      }),
    );
  },
);

router.get(
  "/quizzes/:quizId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GetQuizParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!(await canAccessCourse(course, req.localUser!))) {
      res.status(403).json({ error: "Not a member of this course" });
      return;
    }
    const teacher = isCourseTeacher(course, req.localUser!);
    if (!teacher && quiz.status !== "published") {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }

    await autoSubmitDueSessions(quiz);
    const questions = await getQuizQuestions(quiz.id);
    const attempts = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quiz.id));
    const mine = attempts.find((a) => a.studentId === req.userId!);
    const mySession = teacher ? undefined : await getSession(quiz.id, req.userId!);
    const revealAnswers =
      teacher || (!!quiz.resultsPublishedAt && !!mine);

    res.json(
      GetQuizResponse.parse({
        ...quiz,
        maxScore: quizMaxScore(questions),
        questionCount: questions.length,
        attemptCount: attempts.length,
        questions: sanitizeQuestions(questions, revealAnswers),
        myAttempt: mine
          ? sanitizeAttempt(mine, !!quiz.resultsPublishedAt)
          : null,
        mySession: mySession && !mine ? serializeSession(mySession) : null,
      }),
    );
  },
);

router.put(
  "/quizzes/:quizId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateQuizParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateQuizBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can edit quizzes" });
      return;
    }
    const problem = validateQuestions(parsed.data.questions as QuestionInput[]);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    const attempts = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quiz.id));
    if (attempts.length > 0) {
      res.status(409).json({
        error: "Questions cannot change after students have taken the quiz",
      });
      return;
    }
    // Replacing questions mid-exam would orphan the answers students have
    // already auto-saved (question ids change), so lock edits once anyone starts.
    const [started] = await db
      .select({ id: quizSessionsTable.id })
      .from(quizSessionsTable)
      .where(eq(quizSessionsTable.quizId, quiz.id))
      .limit(1);
    if (started) {
      res.status(409).json({
        error: "Questions cannot change after students have started the quiz",
      });
      return;
    }

    const [updated] = await db
      .update(quizzesTable)
      .set({
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        timeLimitMinutes: parsed.data.timeLimitMinutes ?? null,
      })
      .where(eq(quizzesTable.id, quiz.id))
      .returning();
    await db
      .delete(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, quiz.id));
    await insertQuestions(quiz.id, parsed.data.questions as QuestionInput[]);
    const questions = await getQuizQuestions(quiz.id);

    res.json(
      UpdateQuizResponse.parse({
        ...updated,
        maxScore: quizMaxScore(questions),
        questionCount: questions.length,
        attemptCount: 0,
        questions,
        myAttempt: null,
      }),
    );
  },
);

router.delete(
  "/quizzes/:quizId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteQuizParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can delete quizzes" });
      return;
    }
    await db.delete(quizSessionsTable).where(eq(quizSessionsTable.quizId, quiz.id));
    await db.delete(quizAttemptsTable).where(eq(quizAttemptsTable.quizId, quiz.id));
    await db.delete(quizQuestionsTable).where(eq(quizQuestionsTable.quizId, quiz.id));
    await db.delete(quizzesTable).where(eq(quizzesTable.id, quiz.id));

    void logActivity({
      user: req.localUser!,
      action: "quiz.deleted",
      message: `${req.localUser!.email} deleted quiz "${quiz.title}"`,
      metadata: { quizId: quiz.id, courseId: course.id },
    });

    res.status(204).end();
  },
);

router.post(
  "/quizzes/:quizId/publish",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = PublishQuizParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can publish quizzes" });
      return;
    }

    const [updated] = await db
      .update(quizzesTable)
      .set({ status: "published" })
      .where(eq(quizzesTable.id, quiz.id))
      .returning();
    const questions = await getQuizQuestions(quiz.id);

    if (quiz.status !== "published") {
      void notifyCourseStudents(course.id, {
        type: "quiz.published",
        title: `New quiz: ${quiz.title}`,
        body: `Posted in ${course.title}${quiz.dueDate ? ` — due ${quiz.dueDate.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : ""}`,
        link: `/quiz/${quiz.id}`,
        refId: quiz.id,
      });
    }

    res.json(
      PublishQuizResponse.parse({
        ...updated,
        maxScore: quizMaxScore(questions),
        questionCount: questions.length,
      }),
    );
  },
);

router.post(
  "/quizzes/:quizId/publish-results",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = PublishQuizResultsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can publish results" });
      return;
    }

    // Publishing results closes the quiz, so anyone still mid-quiz is
    // submitted first with their saved work rather than silently dropped.
    await autoSubmitDueSessions(quiz, { includeRunning: true });

    // Finalize every attempt: any answer without a teacher-set score falls
    // back to its auto score (multiple choice); see below for AI suggestions.
    const attempts = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quiz.id));
    const now = new Date();
    for (const attempt of attempts) {
      // Finalize with the teacher's manual score, else the deterministic
      // auto-score for objective questions. The AI suggestion (aiScore) is
      // NEVER auto-finalized — it can be steered by prompt injection in the
      // student's answer, so a short answer with no human/auto score stays 0
      // until a teacher grades it.
      const answers = attempt.answers.map((a) => ({
        ...a,
        score: a.score ?? a.autoScore ?? 0,
      }));
      const total = answers.reduce((sum, a) => sum + (a.score ?? 0), 0);
      await db
        .update(quizAttemptsTable)
        .set({ answers, score: total, status: "graded", gradedAt: now })
        .where(eq(quizAttemptsTable.id, attempt.id));
    }

    const [updated] = await db
      .update(quizzesTable)
      .set({ resultsPublishedAt: now })
      .where(eq(quizzesTable.id, quiz.id))
      .returning();
    const questions = await getQuizQuestions(quiz.id);

    void logActivity({
      user: req.localUser!,
      action: "quiz.results_published",
      message: `${req.localUser!.email} published results for quiz "${quiz.title}"`,
      metadata: { quizId: quiz.id, courseId: course.id },
    });

    void createNotifications(
      attempts.map((a) => ({
        userId: a.studentId,
        type: "quiz.results_published",
        title: `Results published: ${quiz.title}`,
        body: `Your quiz score is now available in ${course.title}.`,
        link: `/quiz/${quiz.id}`,
        courseId: course.id,
        refId: quiz.id,
      })),
    );

    res.json(
      PublishQuizResultsResponse.parse({
        ...updated,
        maxScore: quizMaxScore(questions),
        questionCount: questions.length,
        attemptCount: attempts.length,
      }),
    );
  },
);

router.get(
  "/quizzes/:quizId/attempts",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListQuizAttemptsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can view all attempts" });
      return;
    }

    await autoSubmitDueSessions(quiz);
    const attempts = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quiz.id))
      .orderBy(desc(quizAttemptsTable.submittedAt));

    const studentIds = attempts.map((a) => a.studentId);
    const students = studentIds.length
      ? await db
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, studentIds))
      : [];
    const nameById = new Map(students.map((s) => [s.id, s.name ?? s.email]));

    res.json(
      ListQuizAttemptsResponse.parse(
        attempts.map((a) => ({
          ...a,
          studentName: nameById.get(a.studentId) ?? null,
        })),
      ),
    );
  },
);

router.post(
  "/quizzes/:quizId/attempts",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateQuizAttemptParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateQuizAttemptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(params.data.quizId);
    if (!quiz || !course) {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (!(await canTakeQuiz(course, req.localUser!))) {
      res.status(403).json({ error: "Not enrolled in this course" });
      return;
    }
    if (quiz.status !== "published") {
      res.status(404).json({ error: "Quiz not found" });
      return;
    }
    if (quiz.resultsPublishedAt) {
      res.status(409).json({
        error: "Results have been published; this quiz is closed",
      });
      return;
    }

    const [existing] = await db
      .select()
      .from(quizAttemptsTable)
      .where(
        and(
          eq(quizAttemptsTable.quizId, quiz.id),
          eq(quizAttemptsTable.studentId, req.userId!),
        ),
      );
    if (existing) {
      res.status(409).json({ error: "You have already taken this quiz" });
      return;
    }

    const questions = await getQuizQuestions(quiz.id);
    const byId = new Map(questions.map((q) => [q.id, q]));
    for (const a of parsed.data.answers) {
      if (!byId.has(a.questionId)) {
        res.status(400).json({ error: "Answer references an unknown question" });
        return;
      }
    }

    const session = await getSession(quiz.id, req.userId!);
    if (quiz.timeLimitMinutes && !session) {
      // Otherwise a student could skip the timer by posting answers directly.
      res.status(409).json({ error: "Press Start to begin this timed quiz first." });
      return;
    }

    // The server's clock decides, never the browser's. Past the deadline the
    // answers in this request are ignored and the last auto-saved answers
    // (saved while time remained) are submitted instead.
    const now = new Date();
    const deadline = session ? session.deadlineAt : quiz.dueDate;
    let draft = cleanDraftAnswers(parsed.data.answers, questions);
    let autoSubmitted = false;
    if (isPastDeadline(deadline, now)) {
      if (!session) {
        res.status(409).json({
          error: `This quiz closed at ${formatIst(deadline!)}. Submissions are no longer accepted.`,
        });
        return;
      }
      draft = session.answers;
      autoSubmitted = true;
    } else if (session) {
      await db
        .update(quizSessionsTable)
        .set({ answers: draft, lastSavedAt: now, saveCount: sql`${quizSessionsTable.saveCount} + 1` })
        .where(eq(quizSessionsTable.id, session.id));
    }

    const attempt = await insertAttempt(quiz, req.userId!, questions, draft, autoSubmitted);
    if (!attempt) {
      // Lost a race with a concurrent submit or the server's auto-submit.
      res.status(409).json({ error: "You have already taken this quiz" });
      return;
    }

    void logActivity({
      user: req.localUser!,
      action: autoSubmitted ? "quiz.auto_submitted" : "quiz.attempted",
      message: autoSubmitted
        ? `${req.localUser!.email} submitted late to quiz "${quiz.title}"; their last auto-saved answers were used`
        : `${req.localUser!.email} took quiz "${quiz.title}"`,
      metadata: { quizId: quiz.id, attemptId: attempt.id },
    });

    res.status(201).json(
      CreateQuizAttemptResponse.parse(
        sanitizeAttempt(attempt, !!quiz.resultsPublishedAt),
      ),
    );
  },
);

/**
 * Shared gate for the two session endpoints. Sends the error response and
 * returns undefined when the student may not (or may no longer) work on the quiz.
 */
async function loadQuizForStudent(
  quizId: number,
  user: User,
  res: Response,
): Promise<{ quiz: Quiz; questions: QuizQuestion[] } | undefined> {
  const { quiz, course } = await loadQuizWithCourse(quizId);
  if (!quiz || !course) {
    res.status(404).json({ error: "Quiz not found" });
    return undefined;
  }
  if (!(await canTakeQuiz(course, user))) {
    res.status(403).json({ error: "Not enrolled in this course" });
    return undefined;
  }
  if (quiz.status !== "published") {
    res.status(404).json({ error: "Quiz not found" });
    return undefined;
  }
  if (quiz.resultsPublishedAt) {
    res.status(409).json({ error: "Results have been published; this quiz is closed" });
    return undefined;
  }
  const [existing] = await db
    .select({ id: quizAttemptsTable.id })
    .from(quizAttemptsTable)
    .where(and(eq(quizAttemptsTable.quizId, quiz.id), eq(quizAttemptsTable.studentId, user.id)));
  if (existing) {
    res.status(409).json({ error: "You have already submitted this quiz" });
    return undefined;
  }
  return { quiz, questions: await getQuizQuestions(quiz.id) };
}

const TIME_UP_MESSAGE =
  "Time is up. Your answers saved before the deadline have been submitted.";

router.post(
  "/quizzes/:quizId/session",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = StartQuizSessionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const loaded = await loadQuizForStudent(params.data.quizId, req.localUser!, res);
    if (!loaded) return;
    const { quiz, questions } = loaded;

    const now = new Date();
    let session = await getSession(quiz.id, req.userId!);
    if (!session) {
      if (isPastDeadline(quiz.dueDate, now)) {
        res.status(409).json({ error: `This quiz closed at ${formatIst(quiz.dueDate!)}.` });
        return;
      }
      const [created] = await db
        .insert(quizSessionsTable)
        .values({
          quizId: quiz.id,
          studentId: req.userId!,
          answers: [],
          startedAt: now,
          deadlineAt: computeDeadline(quiz, now),
        })
        .onConflictDoNothing()
        .returning();
      // A second tab may have started it at the same moment: use that one.
      session = created ?? (await getSession(quiz.id, req.userId!));
      if (created) {
        void logActivity({
          user: req.localUser!,
          action: "quiz.started",
          message: `${req.localUser!.email} started quiz "${quiz.title}"`,
          metadata: { quizId: quiz.id, deadlineAt: created.deadlineAt?.toISOString() ?? null },
        });
      }
    }
    if (!session) {
      res.status(500).json({ error: "Could not start the quiz. Please try again." });
      return;
    }

    if (isPastDeadline(session.deadlineAt, now)) {
      await autoSubmitSession(quiz, session, questions);
      res.status(409).json({ error: TIME_UP_MESSAGE });
      return;
    }

    res.json(StartQuizSessionResponse.parse(serializeSession(session)));
  },
);

router.put(
  "/quizzes/:quizId/session",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = SaveQuizSessionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = SaveQuizSessionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const loaded = await loadQuizForStudent(params.data.quizId, req.localUser!, res);
    if (!loaded) return;
    const { quiz, questions } = loaded;

    const session = await getSession(quiz.id, req.userId!);
    if (!session) {
      res.status(409).json({ error: "This quiz has not been started. Reload the page and press Start." });
      return;
    }
    const now = new Date();
    if (isPastDeadline(session.deadlineAt, now)) {
      // Too late to change answers: lock in what was saved while time remained.
      await autoSubmitSession(quiz, session, questions);
      res.status(409).json({ error: TIME_UP_MESSAGE });
      return;
    }

    const [saved] = await db
      .update(quizSessionsTable)
      .set({
        answers: cleanDraftAnswers(parsed.data.answers, questions),
        lastSavedAt: now,
        saveCount: sql`${quizSessionsTable.saveCount} + 1`,
      })
      .where(eq(quizSessionsTable.id, session.id))
      .returning();

    res.json(SaveQuizSessionResponse.parse(serializeSession(saved!)));
  },
);

router.patch(
  "/quiz-attempts/:attemptId/grade",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GradeQuizAttemptParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = GradeQuizAttemptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [attempt] = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.id, params.data.attemptId));
    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }
    const { quiz, course } = await loadQuizWithCourse(attempt.quizId);
    if (!quiz || !course || !isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can grade" });
      return;
    }

    const questions = await getQuizQuestions(quiz.id);
    const pointsById = new Map(questions.map((q) => [q.id, q.points]));
    const overrides = new Map<number, number>();
    for (const s of parsed.data.scores) {
      const max = pointsById.get(s.questionId);
      if (max == null) {
        res.status(400).json({ error: "Score references an unknown question" });
        return;
      }
      overrides.set(s.questionId, Math.max(0, Math.min(max, s.score)));
    }

    const answers = attempt.answers.map((a) => {
      const override = overrides.get(a.questionId);
      const score =
        override != null ? override : a.score ?? a.autoScore ?? 0;
      return { ...a, score };
    });
    const total = answers.reduce((sum, a) => sum + (a.score ?? 0), 0);

    const [updated] = await db
      .update(quizAttemptsTable)
      .set({
        answers,
        score: total,
        status: "graded",
        gradedAt: new Date(),
      })
      .where(eq(quizAttemptsTable.id, attempt.id))
      .returning();

    void logActivity({
      user: req.localUser!,
      action: "quiz.attempt_graded",
      message: `${req.localUser!.email} adjusted a quiz attempt for "${quiz.title}" (${total}/${updated.maxScore})`,
      metadata: { quizId: quiz.id, attemptId: attempt.id, score: total },
    });

    res.json(GradeQuizAttemptResponse.parse(updated));
  },
);

export default router;
