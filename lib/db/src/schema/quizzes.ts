import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  jsonb,
  real,
  unique,
  boolean,
} from "drizzle-orm/pg-core";

export const quizzesTable = pgTable("quizzes", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  // Exam mode: when set, each student gets this many minutes from the moment
  // they press Start (capped by dueDate). Enforced on the server, not the
  // browser, so closing the tab or losing WiFi does not pause the clock.
  timeLimitMinutes: integer("time_limit_minutes"),
  status: text("status").notNull().default("draft"), // draft | published
  resultsPublishedAt: timestamp("results_published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const quizQuestionsTable = pgTable("quiz_questions", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull(),
  position: integer("position").notNull().default(0),
  type: text("type").notNull(), // multiple_choice | short_answer
  prompt: text("prompt").notNull(),
  options: jsonb("options").notNull().default([]).$type<string[]>(),
  correctOption: integer("correct_option"),
  points: integer("points").notNull().default(1),
});

export type QuizAnswer = {
  questionId: number;
  selectedOption?: number | null;
  textAnswer?: string | null;
  autoScore?: number | null;
  aiScore?: number | null;
  aiFeedback?: string | null;
  score?: number | null;
};

export const quizAttemptsTable = pgTable("quiz_attempts", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull(),
  studentId: text("student_id").notNull(),
  answers: jsonb("answers").notNull().default([]).$type<QuizAnswer[]>(),
  score: real("score"),
  maxScore: integer("max_score").notNull().default(0),
  status: text("status").notNull().default("submitted"), // submitted | graded
  // True when the server submitted the student's last auto-saved answers
  // because their time ran out (they never pressed Submit themselves).
  autoSubmitted: boolean("auto_submitted").notNull().default(false),
  submittedAt: timestamp("submitted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
}, (t) => [
  // Take-once enforcement, robust under concurrent submissions.
  unique("quiz_attempts_quiz_student_unique").on(t.quizId, t.studentId),
]);

/** An in-progress answer as the student is typing it (no scores yet). */
export type QuizDraftAnswer = {
  questionId: number;
  selectedOption?: number | null;
  textAnswer?: string | null;
};

/**
 * One row per student per quiz from the moment they open it until (and after)
 * they submit. Holds the auto-saved answers and the server-side deadline, so a
 * dropped connection or a closed tab never loses work, and the clock cannot be
 * reset by reloading. Kept after submission as evidence (start time, last
 * save) for any "my WiFi dropped" dispute.
 */
export const quizSessionsTable = pgTable("quiz_sessions", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull(),
  studentId: text("student_id").notNull(),
  answers: jsonb("answers").notNull().default([]).$type<QuizDraftAnswer[]>(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // null = no deadline (untimed quiz with no due date).
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  lastSavedAt: timestamp("last_saved_at", { withTimezone: true }),
  saveCount: integer("save_count").notNull().default(0),
}, (t) => [
  unique("quiz_sessions_quiz_student_unique").on(t.quizId, t.studentId),
]);

export type Quiz = typeof quizzesTable.$inferSelect;
export type QuizQuestion = typeof quizQuestionsTable.$inferSelect;
export type QuizAttempt = typeof quizAttemptsTable.$inferSelect;
export type QuizSession = typeof quizSessionsTable.$inferSelect;
