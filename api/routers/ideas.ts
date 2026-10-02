import { z } from "zod";
import { eq, desc, or } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { ideas, ideaItems, items, tasks, areas } from "@db/schema";
import { logEvent } from "../lib/events";
import { getModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";

export const ideasRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const all = await db.select().from(ideas).orderBy(desc(ideas.updatedAt));
    const links = await db.select().from(ideaItems);
    const itemIds = [...new Set(links.map((l) => l.itemId))];
    const linkedItems = itemIds.length
      ? await db.select().from(items).where(or(...itemIds.map((i) => eq(items.id, i))))
      : [];
    const itemMap = new Map(linkedItems.map((i) => [i.id, i.name]));
    const allAreas = await db.select().from(areas);
    const areaMap = new Map(allAreas.map((a) => [a.id, a]));
    const taskCounts = await db.select().from(tasks);
    return all.map((idea) => ({
      ...idea,
      area: idea.areaId ? (areaMap.get(idea.areaId) ?? null) : null,
      linkedItems: links
        .filter((l) => l.ideaId === idea.id)
        .map((l) => ({ id: l.itemId, name: itemMap.get(l.itemId) ?? "?" })),
      taskCount: taskCounts.filter((t) => t.ideaId === idea.id).length,
    }));
  }),

  create: publicQuery
    .input(
      z.object({
        title: z.string().min(1),
        body: z.string().optional(),
        areaId: z.number().optional(),
        itemIds: z.array(z.number()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(ideas)
        .values({ title: input.title, body: input.body ?? null, areaId: input.areaId ?? null })
        .$returningId();
      for (const itemId of input.itemIds ?? []) {
        await db.insert(ideaItems).values({ ideaId: id, itemId });
      }
      await logEvent({
        entityType: "idea",
        entityId: id,
        action: "created",
        summary: `Idea "${input.title}" captured`,
      });
      return { id };
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).optional(),
        body: z.string().nullable().optional(),
        areaId: z.number().nullable().optional(),
        status: z.enum(["new", "exploring", "converted", "archived"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;

      // fetch the pre-update row so the history entry can name what actually
      // changed instead of just listing which field keys were touched
      const before = await db.query.ideas.findFirst({ where: eq(ideas.id, id) });
      await db.update(ideas).set(patch).where(eq(ideas.id, id));

      const subject = before?.title ?? `#${id}`;
      const parts: string[] = [];
      if (patch.title !== undefined && patch.title !== before?.title) {
        parts.push(`renamed from "${before?.title ?? "?"}" to "${patch.title}"`);
      }
      if (patch.status !== undefined && patch.status !== before?.status) {
        parts.push(`status changed to "${patch.status}"`);
      }
      if (patch.areaId !== undefined) parts.push("area changed");
      if (patch.body !== undefined) parts.push("body updated");

      await logEvent({
        entityType: "idea",
        entityId: id,
        action: "updated",
        summary: parts.length
          ? `Idea "${subject}" ${parts.join(", ")}`
          : `Idea "${subject}" updated (no changes)`,
        payload: patch,
      });
      return { ok: true };
    }),

  linkItem: publicQuery
    .input(z.object({ ideaId: z.number(), itemId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(ideaItems).values(input);
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      await logEvent({
        entityType: "idea",
        entityId: input.ideaId,
        action: "linked",
        summary: `Idea #${input.ideaId} linked to item "${item?.name ?? input.itemId}"`,
      });
      return { ok: true };
    }),

  unlinkItem: publicQuery
    .input(z.object({ ideaId: z.number(), itemId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(ideaItems).where(eq(ideaItems.ideaId, input.ideaId));
      const row = rows.find((r) => r.itemId === input.itemId);
      if (row) await db.delete(ideaItems).where(eq(ideaItems.id, row.id));
      return { ok: true };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(ideaItems).where(eq(ideaItems.ideaId, input.id));
    await db.delete(ideas).where(eq(ideas.id, input.id));
    await logEvent({
      entityType: "idea",
      entityId: input.id,
      action: "deleted",
      summary: `Idea #${input.id} deleted`,
    });
    return { ok: true };
  }),

  /** AI: break an idea into concrete tasks */
  breakdown: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const idea = await db.query.ideas.findFirst({ where: eq(ideas.id, input.id) });
    if (!idea) throw new Error("idea not found");
    const links = await db.select().from(ideaItems).where(eq(ideaItems.ideaId, idea.id));
    const linked = links.length
      ? await db
          .select()
          .from(items)
          .where(or(...links.map((l) => eq(items.id, l.itemId))))
      : [];

    try {
      const model = await getModel();
      const { object } = await generateObject({
        model,
        schema: z.object({
          tasks: z.array(
            z.object({
              title: z.string(),
              notes: z.string().optional(),
              itemName: z.string().nullable().describe("name of a linked item this task concerns, or null"),
            }),
          ),
        }),
        prompt: `Break this inventory-related idea into 3-7 concrete, actionable tasks.\n\nIdea: ${idea.title}\n${idea.body ?? ""}\n\nRelated items: ${linked.map((i) => i.name).join(", ") || "none"}\n\nTasks should be small, verifiable actions (e.g. "Check free disk space on NAS", not "Improve storage").`,
      });

      let created = 0;
      for (const t of object.tasks) {
        const match = t.itemName
          ? linked.find((i) => i.name.toLowerCase() === t.itemName!.toLowerCase())
          : null;
        await db.insert(tasks).values({
          title: t.title,
          notes: t.notes ?? null,
          ideaId: idea.id,
          areaId: idea.areaId ?? null,
          itemId: match?.id ?? null,
        });
        created++;
      }
      await db.update(ideas).set({ status: "converted" }).where(eq(ideas.id, idea.id));
      await logEvent({
        entityType: "idea",
        entityId: idea.id,
        action: "breakdown",
        summary: `AI broke idea "${idea.title}" into ${created} tasks`,
        actor: "ai",
        payload: { tasks: object.tasks.map((t) => t.title) },
      });
      return { ok: true as const, created };
    } catch (err) {
      const classified = classifyAiError(err);
      return { ok: false as const, error: classified.message };
    }
  }),
});
