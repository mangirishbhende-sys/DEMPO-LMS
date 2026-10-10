import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  coursesTable,
  enrollmentsTable,
  quizzesTable,
  quizQuestionsTable,
  quizAttemptsTable,
  quizSessionsTable,
} from "@workspace/db";

const mockGetAuth = vi.fn();
const mockGetUser = vi.fn();

vi.mock("@clerk/express", () => ({
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  clerkClient: {
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}));

const mockGradeShortAnswer = vi.fn();
vi.mock("../lib/grading", () => ({
  gradeShortAnswer: (...args: unknown[]) => mockGradeShortAnswer(...args),
  gradeTextSubmission: vi.fn(),
  computePlagiarismScore: vi.fn(),
}));

const { default: quizzesRouter } = await import("./quizzes");

const TEST_PREFIX = "task39test";
const TEACHER_ID = `${TEST_PREFIX}_teacher`;
const ALICE = `${TEST_PREFIX}_alice`;
const BOB = `${TEST_PREFIX}_bob`;
const OUTSIDER = `${TEST_PREFIX}_outsider`;
const ALL_IDS = [TEACHER_ID, ALICE, BOB, OUTSIDER];

let courseId: number;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // @ts-expect-error minimal logger stub for tests
    req.log = { warn: () => {}, info: () => {}, error: () => {} };
    next();
  });
  app.use("/api", quizzesRouter);
  return app;
}

const app = buildApp();

const asUser = (id: string) => mockGetAuth.mockReturnValue({ userId: id });

async function cleanup(): Promise<void> {
  const courses = await db
    .select()
    .from(coursesTable)
    .where(eq(coursesTable.teacherId, TEACHER_ID));
  const ids = courses.map((c) => c.id);
  if (ids.length) {
    const quizzes = await db
      .select()
      .from(quizzesTable)
      .where(inArray(quizzesTable.courseId, ids));
    const qIds = quizzes.map((q) => q.id);
    if (qIds.length) {
      await db
        .delete(quizSessionsTable)
        .where(inArray(quizSessionsTable.quizId, qIds));
      await db
        .delete(quizAttemptsTable)
        .where(inArray(quizAttemptsTable.quizId, qIds));
      await db
        .delete(quizQuestionsTable)
        .where(inArray(quizQuestionsTable.quizId, qIds));
    }
    await db.delete(quizzesTable).where(inArray(quizzesTable.courseId, ids));
    await db
      .delete(enrollmentsTable)
      .where(inArray(enrollmentsTable.courseId, ids));
    await db.delete(coursesTable).where(inArray(coursesTable.id, ids));
  }
  await db.delete(usersTable).where(inArray(usersTable.id, ALL_IDS));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(usersTable).values([
    { id: TEACHER_ID, email: `${TEACHER_ID}@example.com`, role: "teacher", name: "Teach" },
    { id: ALICE, email: `${ALICE}@example.com`, role: "student", name: "Alice" },
    { id: BOB, email: `${BOB}@example.com`, role: "student", name: "Bob" },
    { id: OUTSIDER, email: `${OUTSIDER}@example.com`, role: "student", name: "Out" },
  ]);
  const [course] = await db
    .insert(coursesTable)
    .values({ title: "Quiz Test Course", teacherId: TEACHER_ID, inviteCode: "T39AAA" })
    .returning();
  courseId = course!.id;
  await db.insert(enrollmentsTable).values([
    { courseId, studentId: ALICE },
    { courseId, studentId: BOB },
  ]);
});

afterAll(cleanup);

beforeEach(() => {
  mockGetAuth.mockReset();
  mockGetUser.mockReset();
  mockGradeShortAnswer.mockReset();
  mockGradeShortAnswer.mockResolvedValue({ aiScore: 3, aiFeedback: "Decent answer." });
});

const quizBody = {
  title: "Unit 1 Quiz",
  description: "Covers the basics",
  questions: [
    {
      type: "multiple_choice",
      prompt: "2 + 2 = ?",
      options: ["3", "4", "5"],
      correctOption: 1,
      points: 2,
    },
    {
      type: "short_answer",
      prompt: "Explain gravity briefly.",
      points: 5,
    },
  ],
};

describe("quiz management authorization", () => {
  it("rejects unauthenticated create", async () => {
    mockGetAuth.mockReturnValue({ userId: null });
    const res = await request(app).post(`/api/courses/${courseId}/quizzes`).send(quizBody);
    expect(res.status).toBe(401);
  });

  it("rejects students creating quizzes", async () => {
    asUser(ALICE);
    const res = await request(app).post(`/api/courses/${courseId}/quizzes`).send(quizBody);
    expect(res.status).toBe(403);
  });

  it("lets the teacher create a draft quiz", async () => {
    asUser(TEACHER_ID);
    const res = await request(app).post(`/api/courses/${courseId}/quizzes`).send(quizBody);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.maxScore).toBe(7);
    expect(res.body.questions).toHaveLength(2);
  });

  it("rejects invalid multiple-choice questions", async () => {
    asUser(TEACHER_ID);
    const res = await request(app)
      .post(`/api/courses/${courseId}/quizzes`)
      .send({
        title: "Bad quiz",
        questions: [
          { type: "multiple_choice", prompt: "?", options: ["only one"], correctOption: 0, points: 1 },
        ],
      });
    expect(res.status).toBe(400);
  });
});

describe("quiz lifecycle, visibility and scoring", () => {
  let quizId: number;
  let mcQuestionId: number;
  let saQuestionId: number;

  beforeAll(async () => {
    asUser(TEACHER_ID);
    const res = await request(app).post(`/api/courses/${courseId}/quizzes`).send(quizBody);
    quizId = res.body.id;
    mcQuestionId = res.body.questions[0].id;
    saQuestionId = res.body.questions[1].id;
  });

  it("hides draft quizzes from students", async () => {
    asUser(ALICE);
    const list = await request(app).get(`/api/courses/${courseId}/quizzes`);
    expect(list.status).toBe(200);
    expect(list.body.find((q: any) => q.id === quizId)).toBeUndefined();

    const get = await request(app).get(`/api/quizzes/${quizId}`);
    expect(get.status).toBe(404);

    const attempt = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({ answers: [] });
    expect(attempt.status).toBe(404);
  });

  it("only the teacher can publish", async () => {
    asUser(ALICE);
    expect((await request(app).post(`/api/quizzes/${quizId}/publish`)).status).toBe(403);
    asUser(TEACHER_ID);
    const res = await request(app).post(`/api/quizzes/${quizId}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("published");
  });

  it("hides correct answers from students before results are published", async () => {
    asUser(ALICE);
    const res = await request(app).get(`/api/quizzes/${quizId}`);
    expect(res.status).toBe(200);
    for (const q of res.body.questions) {
      expect(q.correctOption).toBeNull();
    }
  });

  it("blocks outsiders from viewing or attempting", async () => {
    asUser(OUTSIDER);
    expect((await request(app).get(`/api/quizzes/${quizId}`)).status).toBe(403);
    const attempt = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({ answers: [] });
    expect(attempt.status).toBe(403);
  });

  it("auto-scores multiple choice and AI-scores short answers on submit", async () => {
    asUser(ALICE);
    const res = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({
        answers: [
          { questionId: mcQuestionId, selectedOption: 1 },
          { questionId: saQuestionId, textAnswer: "Gravity pulls things together." },
        ],
      });
    expect(res.status).toBe(201);
    expect(mockGradeShortAnswer).toHaveBeenCalledOnce();
    // Scores are hidden from the student until results are published.
    expect(res.body.score).toBeNull();
    for (const a of res.body.answers) {
      expect(a.autoScore).toBeNull();
      expect(a.aiScore).toBeNull();
    }
    // But stored internally with the auto/AI scores.
    const [stored] = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quizId));
    const mc = stored!.answers.find((a) => a.questionId === mcQuestionId);
    const sa = stored!.answers.find((a) => a.questionId === saQuestionId);
    expect(mc?.autoScore).toBe(2); // correct option, full points
    expect(sa?.aiScore).toBe(3); // AI suggestion
  });

  it("rejects a second attempt", async () => {
    asUser(ALICE);
    const res = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({ answers: [{ questionId: mcQuestionId, selectedOption: 0 }] });
    expect(res.status).toBe(409);
  });

  it("scores wrong multiple-choice answers as zero", async () => {
    asUser(BOB);
    const res = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({
        answers: [
          { questionId: mcQuestionId, selectedOption: 0 },
          { questionId: saQuestionId, textAnswer: "" },
        ],
      });
    expect(res.status).toBe(201);
    const stored = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quizId));
    const bobAttempt = stored.find((a) => a.studentId === BOB);
    const mc = bobAttempt!.answers.find((a) => a.questionId === mcQuestionId);
    expect(mc?.autoScore).toBe(0);
  });

  it("locks question edits once attempts exist", async () => {
    asUser(TEACHER_ID);
    const res = await request(app).put(`/api/quizzes/${quizId}`).send(quizBody);
    expect(res.status).toBe(409);
  });

  it("only the teacher can list attempts", async () => {
    asUser(ALICE);
    expect((await request(app).get(`/api/quizzes/${quizId}/attempts`)).status).toBe(403);
    asUser(TEACHER_ID);
    const res = await request(app).get(`/api/quizzes/${quizId}/attempts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].studentName).toBeTruthy();
  });

  it("lets the teacher adjust per-question scores (clamped to points)", async () => {
    asUser(TEACHER_ID);
    const attempts = await request(app).get(`/api/quizzes/${quizId}/attempts`);
    const alice = attempts.body.find((a: any) => a.studentId === ALICE);
    const res = await request(app)
      .patch(`/api/quiz-attempts/${alice.id}/grade`)
      .send({ scores: [{ questionId: saQuestionId, score: 99 }] });
    expect(res.status).toBe(200);
    const sa = res.body.answers.find((a: any) => a.questionId === saQuestionId);
    expect(sa.score).toBe(5); // clamped to question points
    expect(res.body.score).toBe(7); // 2 (MC auto) + 5
    expect(res.body.status).toBe("graded");
  });

  it("students cannot grade attempts", async () => {
    const attemptsRows = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quizId));
    asUser(BOB);
    const res = await request(app)
      .patch(`/api/quiz-attempts/${attemptsRows[0]!.id}/grade`)
      .send({ scores: [{ questionId: mcQuestionId, score: 2 }] });
    expect(res.status).toBe(403);
  });

  it("blocks new attempts once results are published", async () => {
    asUser(TEACHER_ID);
    // Create + publish a fresh quiz, publish results with no attempts.
    const created = await request(app)
      .post(`/api/courses/${courseId}/quizzes`)
      .send({ ...quizBody, title: "Closed quiz" });
    const closedId = created.body.id;
    await request(app).post(`/api/quizzes/${closedId}/publish`);
    await request(app).post(`/api/quizzes/${closedId}/publish-results`);

    asUser(ALICE);
    const res = await request(app)
      .post(`/api/quizzes/${closedId}/attempts`)
      .send({
        answers: [{ questionId: created.body.questions[0].id, selectedOption: 1 }],
      });
    expect(res.status).toBe(409);
  });

  it("publishing results finalizes attempts and reveals scores + answers", async () => {
    asUser(ALICE);
    let res = await request(app).get(`/api/quizzes/${quizId}`);
    expect(res.body.myAttempt.score).toBeNull();

    asUser(TEACHER_ID);
    const pub = await request(app).post(`/api/quizzes/${quizId}/publish-results`);
    expect(pub.status).toBe(200);
    expect(pub.body.resultsPublishedAt).toBeTruthy();

    asUser(ALICE);
    res = await request(app).get(`/api/quizzes/${quizId}`);
    expect(res.body.myAttempt.score).toBe(7);
    expect(res.body.myAttempt.status).toBe("graded");
    // Correct answers now revealed.
    const mc = res.body.questions.find((q: any) => q.id === mcQuestionId);
    expect(mc.correctOption).toBe(1);

    // Bob's un-adjusted attempt: MC auto-scores to 0, but the short answer's
    // AI suggestion is NOT auto-finalized (prompt-injection safety), so it
    // stays 0 until a teacher grades it → total 0.
    asUser(TEACHER_ID);
    const attempts = await request(app).get(`/api/quizzes/${quizId}/attempts`);
    const bob = attempts.body.find((a: any) => a.studentId === BOB);
    expect(bob.score).toBe(0);
    expect(bob.status).toBe("graded");
  });
});

/* ---------------- Exam robustness ---------------- */

describe("exam mode: server timer, auto-save, auto-submit", () => {
  async function createPublished(extra: Record<string, unknown>): Promise<any> {
    asUser(TEACHER_ID);
    const created = await request(app)
      .post(`/api/courses/${courseId}/quizzes`)
      .send({ ...quizBody, title: `Exam ${Math.random()}`, ...extra });
    expect(created.status).toBe(201);
    await request(app).post(`/api/quizzes/${created.body.id}/publish`);
    return created.body;
  }

  /** Pretend the student's time ran out a minute ago (past the grace period). */
  async function expireSession(quizId: number, studentId: string): Promise<void> {
    await db
      .update(quizSessionsTable)
      .set({ deadlineAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(quizSessionsTable.quizId, quizId),
          eq(quizSessionsTable.studentId, studentId),
        ),
      );
  }

  it("stores the time limit and requires Start before submitting a timed quiz", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    expect(quiz.timeLimitMinutes).toBe(30);
    asUser(ALICE);
    const res = await request(app)
      .post(`/api/quizzes/${quiz.id}/attempts`)
      .send({ answers: [] });
    expect(res.status).toBe(409);
  });

  it("starts a server-side timer and resumes the same deadline on reload", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    asUser(ALICE);
    const before = Date.now();
    const first = await request(app).post(`/api/quizzes/${quiz.id}/session`);
    expect(first.status).toBe(200);
    const deadline = new Date(first.body.deadlineAt).getTime();
    expect(deadline - before).toBeGreaterThan(29 * 60_000);
    expect(deadline - before).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    expect(first.body.serverNow).toBeTruthy();

    // Reloading the page (or a second tab) must not reset the clock.
    const again = await request(app).post(`/api/quizzes/${quiz.id}/session`);
    expect(again.status).toBe(200);
    expect(again.body.deadlineAt).toBe(first.body.deadlineAt);
    expect(again.body.startedAt).toBe(first.body.startedAt);
  });

  it("caps the deadline at the quiz due date", async () => {
    const due = new Date(Date.now() + 10 * 60_000);
    const quiz = await createPublished({ timeLimitMinutes: 60, dueDate: due.toISOString() });
    asUser(ALICE);
    const res = await request(app).post(`/api/quizzes/${quiz.id}/session`);
    expect(new Date(res.body.deadlineAt).getTime()).toBe(due.getTime());
  });

  it("auto-saves answers and returns them when the student comes back", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc, sa] = quiz.questions;
    asUser(ALICE);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    const save = await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }, { questionId: sa.id, textAnswer: "half done" }] });
    expect(save.status).toBe(200);
    expect(save.body.saveCount).toBe(1);
    expect(save.body.lastSavedAt).toBeTruthy();

    const view = await request(app).get(`/api/quizzes/${quiz.id}`);
    expect(view.body.mySession.answers).toHaveLength(2);
    expect(view.body.mySession.answers.find((a: any) => a.questionId === sa.id).textAnswer).toBe("half done");
  });

  it("only lets enrolled students start a session", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    asUser(OUTSIDER);
    expect((await request(app).post(`/api/quizzes/${quiz.id}/session`)).status).toBe(403);
    asUser(TEACHER_ID);
    expect((await request(app).post(`/api/quizzes/${quiz.id}/session`)).status).toBe(403);
  });

  it("locks question edits once a student has started", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    asUser(ALICE);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    asUser(TEACHER_ID);
    const res = await request(app).put(`/api/quizzes/${quiz.id}`).send(quizBody);
    expect(res.status).toBe(409);
  });

  it("after time is up, rejects saves and submits the last saved answers", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc] = quiz.questions;
    asUser(ALICE);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }] });
    await expireSession(quiz.id, ALICE);

    const late = await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 0 }] });
    expect(late.status).toBe(409);

    const [attempt] = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.quizId, quiz.id));
    expect(attempt!.autoSubmitted).toBe(true);
    // The saved (correct) answer counts, not the late change.
    expect(attempt!.answers.find((a) => a.questionId === mc.id)?.autoScore).toBe(2);
  });

  it("a late Submit uses the saved answers instead of the late ones", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc] = quiz.questions;
    asUser(BOB);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 0 }] });
    await expireSession(quiz.id, BOB);

    const res = await request(app)
      .post(`/api/quizzes/${quiz.id}/attempts`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.autoSubmitted).toBe(true);
    expect(res.body.answers.find((a: any) => a.questionId === mc.id).selectedOption).toBe(0);
  });

  it("a submit inside the time limit is accepted normally", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc] = quiz.questions;
    asUser(ALICE);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    const res = await request(app)
      .post(`/api/quizzes/${quiz.id}/attempts`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.autoSubmitted).toBe(false);
    // Starting again after submitting is refused.
    expect((await request(app).post(`/api/quizzes/${quiz.id}/session`)).status).toBe(409);
  });

  it("rejects submissions to an untimed quiz after its due date", async () => {
    const quiz = await createPublished({ dueDate: new Date(Date.now() + 60 * 60_000).toISOString() });
    await db
      .update(quizzesTable)
      .set({ dueDate: new Date(Date.now() - 5 * 60_000) })
      .where(eq(quizzesTable.id, quiz.id));
    asUser(ALICE);
    const res = await request(app)
      .post(`/api/quizzes/${quiz.id}/attempts`)
      .send({ answers: [{ questionId: quiz.questions[0].id, selectedOption: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed/);
  });

  it("submits a student who disappeared when the teacher opens the results", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc] = quiz.questions;
    asUser(BOB);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }] });
    await expireSession(quiz.id, BOB);

    asUser(TEACHER_ID);
    const res = await request(app).get(`/api/quizzes/${quiz.id}/attempts`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].studentId).toBe(BOB);
    expect(res.body[0].autoSubmitted).toBe(true);
  });

  it("publishing results submits students who are still mid-quiz", async () => {
    const quiz = await createPublished({ timeLimitMinutes: 30 });
    const [mc] = quiz.questions;
    asUser(ALICE);
    await request(app).post(`/api/quizzes/${quiz.id}/session`);
    await request(app)
      .put(`/api/quizzes/${quiz.id}/session`)
      .send({ answers: [{ questionId: mc.id, selectedOption: 1 }] });

    asUser(TEACHER_ID);
    expect((await request(app).post(`/api/quizzes/${quiz.id}/publish-results`)).status).toBe(200);
    asUser(ALICE);
    const view = await request(app).get(`/api/quizzes/${quiz.id}`);
    expect(view.body.myAttempt.score).toBe(2);
  });
});
