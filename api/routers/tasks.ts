import { z } from "zod";
import { eq, desc, isNull, and } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { tasks, timeLogs, items, areas } from "@db/schema";
import { logEvent } from "../lib/events";

export const tasksRouter = createRouter({
  list: procedure.query(async () => {
    const db = getDb();
    const all = await db.select().from(tasks).orderBy(desc(tasks.createdAt));
    const allItems = await db.select().from(items);
    const itemMap = new Map(allItems.map((i) => [i.id, i.name]));
    const allAreas = await db.select().from(areas);
    const areaMap = new Map(allAreas.map((a) => [a.id, a.name]));
    const logs = await db.select().from(timeLogs);
    return all.map((t) => ({
      ...t,
      itemName: t.itemId ? (itemMap.get(t.itemId) ?? null) : null,
      areaName: t.areaId ? (areaMap.get(t.areaId) ?? null) : null,
      totalSeconds: logs
        .filter((l) => l.taskId === t.id)
        .reduce((s, l) => s + Number(l.seconds), 0),
      runningLogId: logs.find((l) => l.taskId === t.id && !l.endedAt)?.id ?? null,
    }));
  }),

  create: procedure
    .input(
      z.object({
        title: z.string().min(1),
        notes: z.string().optional(),
        areaId: z.number().optional(),
        itemId: z.number().optional(),
        ideaId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(tasks)
        .values({
          title: input.title,
          notes: input.notes ?? null,
          areaId: input.areaId ?? null,
          itemId: input.itemId ?? null,
          ideaId: input.ideaId ?? null,
        })
        .$returningId();
      await logEvent({
        entityType: "task",
        entityId: id,
        action: "created",
        summary: `Task "${input.title}" created`,
      });
      return { id };
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).optional(),
        notes: z.string().nullable().optional(),
        areaId: z.number().nullable().optional(),
        itemId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      await getDb().update(tasks).set(patch).where(eq(tasks.id, id));
      await logEvent({
        entityType: "task",
        entityId: id,
        action: "updated",
        summary: `Task #${id} updated`,
        payload: patch,
      });
      return { ok: true };
    }),

  setStatus: procedure
    .input(z.object({ id: z.number(), status: z.enum(["todo", "doing", "done"]) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === "doing") patch.startedAt = new Date();
      if (input.status === "done") {
        patch.completedAt = new Date();
        // stop any running timer
        const running = await db
          .select()
          .from(timeLogs)
          .where(and(eq(timeLogs.taskId, input.id), isNull(timeLogs.endedAt)));
        for (const log of running) {
          const secs = Math.max(0, Math.floor((Date.now() - log.startedAt.getTime()) / 1000));
          await db
            .update(timeLogs)
            .set({ endedAt: new Date(), seconds: secs })
            .where(eq(timeLogs.id, log.id));
        }
      }
      await db.update(tasks).set(patch).where(eq(tasks.id, input.id));
      const t = await db.query.tasks.findFirst({ where: eq(tasks.id, input.id) });
      await logEvent({
        entityType: "task",
        entityId: input.id,
        action: input.status === "done" ? "completed" : "status-changed",
        summary: `Task "${t?.title ?? input.id}" → ${input.status}`,
      });
      return { ok: true };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(timeLogs).where(eq(timeLogs.taskId, input.id));
    await db.delete(tasks).where(eq(tasks.id, input.id));
    await logEvent({
      entityType: "task",
      entityId: input.id,
      action: "deleted",
      summary: `Task #${input.id} deleted`,
    });
    return { ok: true };
  }),

  /** start a timer — stops any other running timer first */
  startTimer: procedure
    .input(z.object({ taskId: z.number(), note: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const running = await db.select().from(timeLogs).where(isNull(timeLogs.endedAt));
      for (const log of running) {
        const secs = Math.max(0, Math.floor((Date.now() - log.startedAt.getTime()) / 1000));
        await db
          .update(timeLogs)
          .set({ endedAt: new Date(), seconds: secs })
          .where(eq(timeLogs.id, log.id));
      }
      const [{ id }] = await db
        .insert(timeLogs)
        .values({ taskId: input.taskId, startedAt: new Date(), note: input.note ?? null })
        .$returningId();
      const t = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
      await logEvent({
        entityType: "task",
        entityId: input.taskId,
        action: "timer-started",
        summary: `Timer started on "${t?.title ?? input.taskId}"`,
      });
      return { id };
    }),

  stopTimer: procedure.input(z.object({ taskId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const running = await db
      .select()
      .from(timeLogs)
      .where(and(eq(timeLogs.taskId, input.taskId), isNull(timeLogs.endedAt)));
    for (const log of running) {
      const secs = Math.max(0, Math.floor((Date.now() - log.startedAt.getTime()) / 1000));
      await db
        .update(timeLogs)
        .set({ endedAt: new Date(), seconds: secs })
        .where(eq(timeLogs.id, log.id));
    }
    if (running.length) {
      const t = await db.query.tasks.findFirst({ where: eq(tasks.id, input.taskId) });
      await logEvent({
        entityType: "task",
        entityId: input.taskId,
        action: "timer-stopped",
        summary: `Timer stopped on "${t?.title ?? input.taskId}"`,
      });
    }
    return { ok: true, stopped: running.length };
  }),

  runningTimer: procedure.query(async () => {
    const db = getDb();
    const running = await db.select().from(timeLogs).where(isNull(timeLogs.endedAt));
    if (!running.length) return null;
    const log = running[0];
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, log.taskId) });
    return { logId: log.id, taskId: log.taskId, taskTitle: task?.title ?? "?", startedAt: log.startedAt };
  }),
});
