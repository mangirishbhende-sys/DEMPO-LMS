import { eq, or, inArray, isNull, and } from "drizzle-orm";
import {
  db,
  usersTable,
  coursesTable,
  cohortsTable,
  cohortMembersTable,
  enrollmentsTable,
  invitesTable,
  courseMaterialReadsTable,
  notificationsTable,
  messagesTable,
  submissionsTable,
  submissionSimilaritiesTable,
  activityLogsTable,
  quizAttemptsTable,
  quizSessionsTable,
} from "@workspace/db";

/**
 * Deletes a user account together with every row that references it, so no
 * dangling references (cohort memberships, enrollments, notifications, ...)
 * are left behind.
 *
 * Notes:
 * - Activity logs are preserved for auditing: their nullable `userId` is
 *   set to null instead of deleting the rows.
 * - Deletion is BLOCKED if the user still owns courses: cascading a whole
 *   course (enrollments, assignments, materials, sessions...) is a separate
 *   admin decision, and deleting the teacher anyway would orphan the courses.
 *   Callers must reassign or delete the courses first. Cohorts the user owns
 *   are removed (along with their member rows) since they are private to the
 *   teacher.
 */
export type DeleteUserResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "owns_courses"; courseIds?: number[] };

export async function deleteUserAndReferences(
  userId: string,
): Promise<DeleteUserResult> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) return { ok: false, reason: "not_found" };

  const ownedCourses = await db
    .select({ id: coursesTable.id })
    .from(coursesTable)
    .where(eq(coursesTable.teacherId, userId));
  if (ownedCourses.length) {
    return {
      ok: false,
      reason: "owns_courses",
      courseIds: ownedCourses.map((c) => c.id),
    };
  }

  await db.transaction(async (tx) => {
    // Cohort memberships where the user is a member.
    await tx
      .delete(cohortMembersTable)
      .where(eq(cohortMembersTable.studentId, userId));

    // Cohorts the user owns (as a teacher), including their member rows.
    const ownedCohorts = await tx
      .select({ id: cohortsTable.id })
      .from(cohortsTable)
      .where(eq(cohortsTable.teacherId, userId));
    const ownedCohortIds = ownedCohorts.map((c) => c.id);
    if (ownedCohortIds.length) {
      await tx
        .delete(cohortMembersTable)
        .where(inArray(cohortMembersTable.cohortId, ownedCohortIds));
      await tx
        .delete(cohortsTable)
        .where(inArray(cohortsTable.id, ownedCohortIds));
    }

    // Course enrollments.
    await tx
      .delete(enrollmentsTable)
      .where(eq(enrollmentsTable.studentId, userId));

    // Pending invites addressed to this user's email.
    const email = (user.email ?? "").trim().toLowerCase();
    if (email) {
      const invites = await tx.select().from(invitesTable);
      const staleIds = invites
        .filter((i) => i.email.trim().toLowerCase() === email)
        .map((i) => i.id);
      if (staleIds.length) {
        await tx.delete(invitesTable).where(inArray(invitesTable.id, staleIds));
      }
    }

    // Read markers and notifications.
    await tx
      .delete(courseMaterialReadsTable)
      .where(eq(courseMaterialReadsTable.userId, userId));
    await tx
      .delete(notificationsTable)
      .where(eq(notificationsTable.userId, userId));

    // Messages sent by the user, and direct messages addressed to them.
    await tx
      .delete(messagesTable)
      .where(
        or(
          eq(messagesTable.senderId, userId),
          eq(messagesTable.recipientId, userId),
        ),
      );

    // Submissions and any similarity pairs referencing them.
    const submissions = await tx
      .select({ id: submissionsTable.id })
      .from(submissionsTable)
      .where(eq(submissionsTable.studentId, userId));
    const submissionIds = submissions.map((s) => s.id);
    if (submissionIds.length) {
      await tx
        .delete(submissionSimilaritiesTable)
        .where(
          or(
            inArray(submissionSimilaritiesTable.submissionAId, submissionIds),
            inArray(submissionSimilaritiesTable.submissionBId, submissionIds),
          ),
        );
      await tx
        .delete(submissionsTable)
        .where(inArray(submissionsTable.id, submissionIds));
    }

    // Quiz attempts and in-progress/auto-saved quiz sessions.
    await tx
      .delete(quizAttemptsTable)
      .where(eq(quizAttemptsTable.studentId, userId));
    await tx
      .delete(quizSessionsTable)
      .where(eq(quizSessionsTable.studentId, userId));

    // Keep activity logs for auditing, but detach them from the user.
    await tx
      .update(activityLogsTable)
      .set({ userId: null })
      .where(eq(activityLogsTable.userId, userId));

    // Finally the user row itself.
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
  });

  return { ok: true };
}
