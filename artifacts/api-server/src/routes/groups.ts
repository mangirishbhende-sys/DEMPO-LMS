import { Router, type IRouter } from "express";
import { eq, and, inArray, notInArray } from "drizzle-orm";
import {
  db,
  courseGroupsTable,
  courseGroupMembersTable,
  assignmentGroupsTable,
  groupTasksTable,
  submissionsTable,
  enrollmentsTable,
  usersTable,
  assignmentsTable,
  type CourseGroup,
  type User,
} from "@workspace/db";
import {
  ListCourseGroupsParams,
  CreateCourseGroupParams,
  CreateCourseGroupBody,
  CreateCourseGroupResponse,
  UpdateCourseGroupParams,
  UpdateCourseGroupBody,
  UpdateCourseGroupResponse,
  DeleteCourseGroupParams,
  ListCourseGroupsResponse,
  ListGroupTasksParams,
  ListGroupTasksResponse,
  CreateGroupTaskParams,
  CreateGroupTaskBody,
  CreateGroupTaskResponse,
  UpdateGroupTaskParams,
  UpdateGroupTaskBody,
  UpdateGroupTaskResponse,
  DeleteGroupTaskParams,
  GetGroupRemovalImpactParams,
  GetGroupRemovalImpactBody,
  GetGroupRemovalImpactResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getCourse, isCourseTeacher } from "../lib/authz";

const router: IRouter = Router();

/** Serialize a group with its members (leader flag included). */
export async function serializeGroup(group: CourseGroup) {
  const members = await db
    .select()
    .from(courseGroupMembersTable)
    .where(eq(courseGroupMembersTable.groupId, group.id));
  const studentIds = members.map((m) => m.studentId);
  const users = studentIds.length
    ? await db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, studentIds))
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const leader = members.find((m) => m.isLeader);
  return {
    id: group.id,
    courseId: group.courseId,
    name: group.name,
    leaderId: leader?.studentId ?? null,
    createdAt: group.createdAt,
    members: members.map((m) => ({
      id: m.studentId,
      name: userById.get(m.studentId)?.name ?? null,
      email: userById.get(m.studentId)?.email ?? null,
      avatarUrl: userById.get(m.studentId)?.avatarUrl ?? null,
      isLeader: m.isLeader,
    })),
  };
}

async function getGroup(groupId: number): Promise<CourseGroup | undefined> {
  const [group] = await db
    .select()
    .from(courseGroupsTable)
    .where(eq(courseGroupsTable.id, groupId));
  return group;
}

/** Validates memberIds are enrolled; returns an error message or null. */
async function validateMembers(
  courseId: number,
  memberIds: string[],
  leaderId: string | null | undefined,
): Promise<string | null> {
  if (memberIds.length === 0) return "A group needs at least one member";
  if (leaderId && !memberIds.includes(leaderId))
    return "The leader must be a member of the group";
  const enrolled = await db
    .select()
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.courseId, courseId),
        inArray(enrollmentsTable.studentId, memberIds),
      ),
    );
  const enrolledIds = new Set(enrolled.map((e) => e.studentId));
  if (memberIds.some((id) => !enrolledIds.has(id)))
    return "All group members must be enrolled in the course";
  return null;
}

router.get(
  "/courses/:courseId/groups",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListCourseGroupsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const course = await getCourse(params.data.courseId);
    if (!course) {
      res.status(404).json({ error: "Course not found" });
      return;
    }
    const isTeacher = isCourseTeacher(course, req.localUser!);

    const groups = await db
      .select()
      .from(courseGroupsTable)
      .where(eq(courseGroupsTable.courseId, course.id));

    let visible = groups;
    if (!isTeacher) {
      // Students see only the groups they belong to.
      const memberships = await db
        .select()
        .from(courseGroupMembersTable)
        .where(eq(courseGroupMembersTable.studentId, req.userId!));
      const myGroupIds = new Set(memberships.map((m) => m.groupId));
      visible = groups.filter((g) => myGroupIds.has(g.id));
    }

    res.json(
      ListCourseGroupsResponse.parse(
        await Promise.all(visible.map(serializeGroup)),
      ),
    );
  },
);

router.post(
  "/courses/:courseId/groups",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateCourseGroupParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateCourseGroupBody.safeParse(req.body);
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
      res.status(403).json({ error: "Only the course teacher can manage groups" });
      return;
    }

    const memberIds = [...new Set(parsed.data.memberIds)];
    const err = await validateMembers(course.id, memberIds, parsed.data.leaderId);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    const group = await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(courseGroupsTable)
        .values({ courseId: course.id, name: parsed.data.name.trim() })
        .returning();
      await tx.insert(courseGroupMembersTable).values(
        memberIds.map((studentId) => ({
          groupId: g.id,
          studentId,
          isLeader: studentId === parsed.data.leaderId,
        })),
      );
      return g;
    });

    res.status(201).json(CreateCourseGroupResponse.parse(await serializeGroup(group)));
  },
);

router.patch(
  "/groups/:groupId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateCourseGroupParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateCourseGroupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const group = await getGroup(params.data.groupId);
    const course = group ? await getCourse(group.courseId) : undefined;
    if (!group || !course) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can manage groups" });
      return;
    }

    const currentMembers = await db
      .select()
      .from(courseGroupMembersTable)
      .where(eq(courseGroupMembersTable.groupId, group.id));
    const memberIds = parsed.data.memberIds
      ? [...new Set(parsed.data.memberIds)]
      : currentMembers.map((m) => m.studentId);
    const leaderId =
      parsed.data.leaderId !== undefined
        ? parsed.data.leaderId
        : (currentMembers.find((m) => m.isLeader)?.studentId ?? null);
    // A previous leader who is no longer a member simply drops off.
    const effectiveLeader = leaderId && memberIds.includes(leaderId) ? leaderId : null;
    if (parsed.data.leaderId && !memberIds.includes(parsed.data.leaderId)) {
      res.status(400).json({ error: "The leader must be a member of the group" });
      return;
    }

    const err = await validateMembers(course.id, memberIds, effectiveLeader);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    await db.transaction(async (tx) => {
      if (parsed.data.name !== undefined) {
        await tx
          .update(courseGroupsTable)
          .set({ name: parsed.data.name.trim() })
          .where(eq(courseGroupsTable.id, group.id));
      }
      await tx
        .delete(courseGroupMembersTable)
        .where(eq(courseGroupMembersTable.groupId, group.id));
      await tx.insert(courseGroupMembersTable).values(
        memberIds.map((studentId) => ({
          groupId: group.id,
          studentId,
          isLeader: studentId === effectiveLeader,
        })),
      );
      // Drop tasks assigned to students who left the group.
      await tx
        .delete(groupTasksTable)
        .where(
          and(
            eq(groupTasksTable.groupId, group.id),
            notInArray(groupTasksTable.assigneeId, memberIds),
          ),
        );
    });

    const updated = await getGroup(group.id);
    res.json(UpdateCourseGroupResponse.parse(await serializeGroup(updated!)));
  },
);

router.post(
  "/groups/:groupId/removal-impact",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GetGroupRemovalImpactParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = GetGroupRemovalImpactBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const group = await getGroup(params.data.groupId);
    const course = group ? await getCourse(group.courseId) : undefined;
    if (!group || !course) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can check removal impact" });
      return;
    }

    const removedIds = body.data.removedIds;

    if (removedIds.length === 0) {
      res.json(GetGroupRemovalImpactResponse.parse({ openTasks: [], submissionsCount: 0 }));
      return;
    }

    // Open (not-done) tasks assigned to the members being removed
    const openTasks = await db
      .select()
      .from(groupTasksTable)
      .where(
        and(
          eq(groupTasksTable.groupId, group.id),
          inArray(groupTasksTable.assigneeId, removedIds),
          eq(groupTasksTable.done, false),
        ),
      );

    const taskUsers = openTasks.length
      ? await db
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, openTasks.map((t) => t.assigneeId)))
      : [];
    const taskUserById = new Map(taskUsers.map((u) => [u.id, u]));

    // Count submissions this group has already made
    const subs = await db
      .select({ id: submissionsTable.id })
      .from(submissionsTable)
      .where(eq(submissionsTable.groupId, group.id));

    res.json(
      GetGroupRemovalImpactResponse.parse({
        openTasks: openTasks.map((t) => ({
          id: t.id,
          description: t.description,
          assigneeId: t.assigneeId,
          assigneeName: taskUserById.get(t.assigneeId)?.name ?? null,
        })),
        submissionsCount: subs.length,
      }),
    );
  },
);

router.delete(
  "/groups/:groupId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteCourseGroupParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const group = await getGroup(params.data.groupId);
    const course = group ? await getCourse(group.courseId) : undefined;
    if (!group || !course) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (!isCourseTeacher(course, req.localUser!)) {
      res.status(403).json({ error: "Only the course teacher can manage groups" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(groupTasksTable)
        .where(eq(groupTasksTable.groupId, group.id));
      await tx
        .delete(assignmentGroupsTable)
        .where(eq(assignmentGroupsTable.groupId, group.id));
      await tx
        .delete(courseGroupMembersTable)
        .where(eq(courseGroupMembersTable.groupId, group.id));
      // Detach surviving submissions so they remain attributed to the submitter
      // rather than pointing at a now-deleted group. This ensures grades, stats,
      // and leaderboard keep crediting the student who actually submitted.
      await tx
        .update(submissionsTable)
        .set({ groupId: null })
        .where(eq(submissionsTable.groupId, group.id));
      await tx
        .delete(courseGroupsTable)
        .where(eq(courseGroupsTable.id, group.id));
    });

    res.status(204).end();
  },
);

// ---------- Group tasks ----------

type TaskContext = {
  group: CourseGroup;
  isTeacher: boolean;
  isMember: boolean;
  isLeader: boolean;
};

/** Loads the group + viewer's relationship, verifying the assignment targets it. */
async function loadTaskContext(
  assignmentId: number,
  groupId: number,
  user: Pick<User, "id" | "role">,
): Promise<TaskContext | { error: string; status: number }> {
  const [assignment] = await db
    .select()
    .from(assignmentsTable)
    .where(eq(assignmentsTable.id, assignmentId));
  const group = await getGroup(groupId);
  if (!assignment || !group) return { error: "Not found", status: 404 };
  const [link] = await db
    .select()
    .from(assignmentGroupsTable)
    .where(
      and(
        eq(assignmentGroupsTable.assignmentId, assignmentId),
        eq(assignmentGroupsTable.groupId, groupId),
      ),
    );
  if (!link) return { error: "Not found", status: 404 };
  const course = await getCourse(group.courseId);
  if (!course) return { error: "Not found", status: 404 };
  const isTeacher = isCourseTeacher(course, user);
  const userId = user.id;
  const [membership] = await db
    .select()
    .from(courseGroupMembersTable)
    .where(
      and(
        eq(courseGroupMembersTable.groupId, groupId),
        eq(courseGroupMembersTable.studentId, userId),
      ),
    );
  if (!isTeacher && !membership) return { error: "Not found", status: 404 };
  return {
    group,
    isTeacher,
    isMember: !!membership,
    isLeader: !!membership?.isLeader,
  };
}

async function serializeTask(task: typeof groupTasksTable.$inferSelect) {
  const [assignee] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, task.assigneeId));
  return { ...task, assigneeName: assignee?.name ?? null };
}

router.get(
  "/assignments/:assignmentId/groups/:groupId/tasks",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = ListGroupTasksParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const ctx = await loadTaskContext(
      params.data.assignmentId,
      params.data.groupId,
      req.localUser!,
    );
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    const tasks = await db
      .select()
      .from(groupTasksTable)
      .where(
        and(
          eq(groupTasksTable.assignmentId, params.data.assignmentId),
          eq(groupTasksTable.groupId, params.data.groupId),
        ),
      );
    res.json(
      ListGroupTasksResponse.parse(await Promise.all(tasks.map(serializeTask))),
    );
  },
);

router.post(
  "/assignments/:assignmentId/groups/:groupId/tasks",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CreateGroupTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = CreateGroupTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const ctx = await loadTaskContext(
      params.data.assignmentId,
      params.data.groupId,
      req.localUser!,
    );
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    if (!ctx.isLeader) {
      res.status(403).json({ error: "Only the group leader can create tasks" });
      return;
    }
    // Assignee must be a group member.
    const [assigneeMembership] = await db
      .select()
      .from(courseGroupMembersTable)
      .where(
        and(
          eq(courseGroupMembersTable.groupId, ctx.group.id),
          eq(courseGroupMembersTable.studentId, parsed.data.assigneeId),
        ),
      );
    if (!assigneeMembership) {
      res.status(400).json({ error: "Assignee must be a group member" });
      return;
    }

    const [task] = await db
      .insert(groupTasksTable)
      .values({
        assignmentId: params.data.assignmentId,
        groupId: ctx.group.id,
        assigneeId: parsed.data.assigneeId,
        description: parsed.data.description.trim(),
      })
      .returning();
    res.status(201).json(CreateGroupTaskResponse.parse(await serializeTask(task)));
  },
);

router.patch(
  "/group-tasks/:taskId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = UpdateGroupTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateGroupTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [task] = await db
      .select()
      .from(groupTasksTable)
      .where(eq(groupTasksTable.id, params.data.taskId));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const ctx = await loadTaskContext(task.assignmentId, task.groupId, req.localUser!);
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }

    const wantsFullEdit =
      parsed.data.description !== undefined || parsed.data.assigneeId !== undefined;
    if (wantsFullEdit && !ctx.isLeader) {
      res.status(403).json({ error: "Only the group leader can edit tasks" });
      return;
    }
    if (parsed.data.done !== undefined && !ctx.isLeader) {
      if (task.assigneeId !== req.userId!) {
        res
          .status(403)
          .json({ error: "Only the assignee or leader can update task status" });
        return;
      }
    }
    if (parsed.data.assigneeId !== undefined) {
      const [assigneeMembership] = await db
        .select()
        .from(courseGroupMembersTable)
        .where(
          and(
            eq(courseGroupMembersTable.groupId, task.groupId),
            eq(courseGroupMembersTable.studentId, parsed.data.assigneeId),
          ),
        );
      if (!assigneeMembership) {
        res.status(400).json({ error: "Assignee must be a group member" });
        return;
      }
    }

    const updates: Partial<typeof groupTasksTable.$inferInsert> = {};
    if (parsed.data.description !== undefined)
      updates.description = parsed.data.description.trim();
    if (parsed.data.assigneeId !== undefined)
      updates.assigneeId = parsed.data.assigneeId;
    if (parsed.data.done !== undefined) updates.done = parsed.data.done;

    const [updated] = Object.keys(updates).length
      ? await db
          .update(groupTasksTable)
          .set(updates)
          .where(eq(groupTasksTable.id, task.id))
          .returning()
      : [task];
    res.json(UpdateGroupTaskResponse.parse(await serializeTask(updated)));
  },
);

router.delete(
  "/group-tasks/:taskId",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteGroupTaskParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [task] = await db
      .select()
      .from(groupTasksTable)
      .where(eq(groupTasksTable.id, params.data.taskId));
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const ctx = await loadTaskContext(task.assignmentId, task.groupId, req.localUser!);
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    if (!ctx.isLeader) {
      res.status(403).json({ error: "Only the group leader can delete tasks" });
      return;
    }
    await db.delete(groupTasksTable).where(eq(groupTasksTable.id, task.id));
    res.status(204).end();
  },
);

export default router;
