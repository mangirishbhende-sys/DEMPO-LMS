/**
 * Seeds sample data for the LOCAL DEMO preview (LOCAL_DEMO_AUTH=true).
 * Safe to re-run: it skips anything that already exists.
 *
 *   pnpm --filter @workspace/scripts run seed-demo
 *
 * Every user id starts with "demo_" — the only ids demo login accepts.
 * Never run this against a production database.
 */
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  coursesTable,
  enrollmentsTable,
  assignmentsTable,
  quizzesTable,
  quizQuestionsTable,
} from "@workspace/db";

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to seed demo data with NODE_ENV=production.");
}

const TEACHER = "demo_teacher";
const STUDENTS = [
  { id: "demo_riya", name: "Riya Naik", email: "riya.naik@demo.local" },
  { id: "demo_arjun", name: "Arjun Kamat", email: "arjun.kamat@demo.local" },
  { id: "demo_sara", name: "Sara D'Souza", email: "sara.dsouza@demo.local" },
];

async function main() {
  await db
    .insert(usersTable)
    .values([
      { id: TEACHER, name: "Prof. Demo Teacher", email: "teacher@demo.local", role: "teacher", isAdmin: true },
      { id: "demo_dean", name: "Dean (demo)", email: "dean@demo.local", role: "dean" },
      ...STUDENTS.map((s) => ({ ...s, role: "student" })),
    ])
    .onConflictDoNothing();

  const [existing] = await db.select().from(coursesTable).where(eq(coursesTable.inviteCode, "DEMOHR"));
  if (existing) {
    console.log(`Demo course already exists (id ${existing.id}); users ensured. Nothing else to do.`);
    return;
  }

  const [course] = await db
    .insert(coursesTable)
    .values({
      title: "AI Applications in New-Age HR",
      description: "PGDM elective (demo). How AI is changing hiring, performance and people analytics — and where it must not.",
      teacherId: TEACHER,
      inviteCode: "DEMOHR",
    })
    .returning();

  await db.insert(enrollmentsTable).values(STUDENTS.map((s) => ({ courseId: course!.id, studentId: s.id })));

  const day = 24 * 60 * 60 * 1000;
  await db.insert(assignmentsTable).values([
    {
      courseId: course!.id,
      title: "Case study: AI screening at a Goan BPO",
      description: "A 600-word memo: should the HR head adopt AI CV screening? Cover bias, DPDP consent and one safeguard you would insist on.",
      dueDate: new Date(Date.now() + 7 * day),
      allowedTypes: ["text", "file", "link"],
      maxScore: 20,
    },
    {
      courseId: course!.id,
      title: "Reflection: one HR process you would never automate",
      dueDate: new Date(Date.now() + 14 * day),
      allowedTypes: ["text", "audio"],
      maxScore: 10,
    },
  ]);

  // A timed quiz to try the exam-robustness feature: Start → auto-save → timer.
  const [timed] = await db
    .insert(quizzesTable)
    .values({
      courseId: course!.id,
      title: "Unit 1 check-in (timed, 10 minutes)",
      description: "Try it: answer a question, turn WiFi off, keep answering, reload — your answers survive.",
      dueDate: new Date(Date.now() + 3 * day),
      timeLimitMinutes: 10,
      status: "published",
    })
    .returning();
  await db.insert(quizQuestionsTable).values([
    {
      quizId: timed!.id, position: 0, type: "multiple_choice", points: 2,
      prompt: "Under India's DPDP Act, processing a student's personal data generally needs…",
      options: ["Nothing, if it is for education", "Consent or another lawful ground, for a stated purpose", "Only a signed paper form", "Approval from UGC"],
      correctOption: 1,
    },
    {
      quizId: timed!.id, position: 1, type: "multiple_choice", points: 2,
      prompt: "An AI screening tool rejects far more women than men for the same role. This is an example of…",
      options: ["Overfitting", "Adverse impact / bias", "Data residency", "Prompt injection"],
      correctOption: 1,
    },
    {
      quizId: timed!.id, position: 2, type: "short_answer", points: 5,
      prompt: "Name one HR decision that should always have a human in the loop, and say why in two sentences.",
      options: [],
      correctOption: null,
    },
  ]);

  const [untimed] = await db
    .insert(quizzesTable)
    .values({
      courseId: course!.id,
      title: "Practice quiz (untimed)",
      status: "published",
    })
    .returning();
  await db.insert(quizQuestionsTable).values([
    {
      quizId: untimed!.id, position: 0, type: "multiple_choice", points: 1,
      prompt: "Which of these is people analytics?",
      options: ["Predicting attrition from engagement data", "Printing payslips", "Booking interview rooms"],
      correctOption: 0,
    },
  ]);

  console.log(`Seeded demo course "${course!.title}" (invite code DEMOHR) with 3 students, 2 assignments, 2 quizzes.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
