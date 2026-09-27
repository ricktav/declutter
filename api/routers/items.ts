import { z } from "zod";
import { eq, desc, or, and } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items, attachments, relations, tasks, ideaItems, ideas } from "@db/schema";
import { logEvent } from "../lib/events";

/** crude name-similarity: shared significant tokens */
function nameScore(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

export const itemsRouter = createRouter({
  listByArea: publicQuery
    .input(z.object({ areaId: z.number(), includeArchived: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(items)
        .where(
          input.includeArchived
            ? eq(items.areaId, input.areaId)
            : and(eq(items.areaId, input.areaId), eq(items.status, "active")),
        )
        .orderBy(desc(items.updatedAt));
      const atts = await db
        .select()
        .from(attachments)
        .where(eq(attachments.kind, "image"));
      const imgMap = new Map<number, string>();
      for (const a of atts) {
        if (a.itemId && a.storageKey && !imgMap.has(a.itemId)) imgMap.set(a.itemId, a.storageKey);
      }
      return rows.map((r) => ({ ...r, imageKey: imgMap.get(r.id) ?? null }));
    }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
    if (!item) return null;
    const area = await db.query.areas.findFirst({ where: eq(areas.id, item.areaId) });
    const atts = await db
      .select()
      .from(attachments)
      .where(eq(attachments.itemId, item.id))
      .orderBy(desc(attachments.createdAt));
    const rels = await db
      .select()
      .from(relations)
      .where(or(eq(relations.fromItemId, item.id), eq(relations.toItemId, item.id)))
      .orderBy(desc(relations.createdAt));
    const otherIds = [...new Set(rels.flatMap((r) => [r.fromItemId, r.toItemId]))].filter(
      (x) => x !== item.id,
    );
    const others = otherIds.length
      ? await db.select().from(items).where(or(...otherIds.map((i) => eq(items.id, i))))
      : [];
    const nameMap = new Map(others.map((o) => [o.id, o.name]));
    const itemTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.itemId, item.id))
      .orderBy(desc(tasks.createdAt));
    const links = await db.select().from(ideaItems).where(eq(ideaItems.itemId, item.id));
    const itemIdeas = links.length
      ? await db
          .select()
          .from(ideas)
          .where(or(...links.map((l) => eq(ideas.id, l.ideaId))))
      : [];
    return {
      ...item,
      area,
      attachments: atts,
      relations: rels.map((r) => ({
        ...r,
        otherItemId: r.fromItemId === item.id ? r.toItemId : r.fromItemId,
        otherItemName: nameMap.get(r.fromItemId === item.id ? r.toItemId : r.fromItemId) ?? "?",
        direction: r.fromItemId === item.id ? ("out" as const) : ("in" as const),
      })),
      tasks: itemTasks,
      ideas: itemIdeas,
    };
  }),

  create: publicQuery
    .input(
      z.object({
        areaId: z.number(),
        name: z.string().min(1),
        description: z.string().optional(),
        attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(items)
        .values({
          areaId: input.areaId,
          name: input.name,
          description: input.description ?? null,
          attributes: input.attributes ?? null,
        })
        .$returningId();
      await logEvent({
        entityType: "item",
        entityId: id,
        action: "created",
        summary: `Item "${input.name}" created`,
        payload: { areaId: input.areaId, attributes: input.attributes },
      });

      // auto-suggest relations to similar items (recorded as suggestions)
      const siblings = await db
        .select()
        .from(items)
        .where(and(eq(items.status, "active")));
      const suggestions: number[] = [];
      for (const s of siblings) {
        if (s.id === id) continue;
        if (nameScore(input.name, s.name) >= 0.5) {
          await db.insert(relations).values({
            fromItemId: id,
            toItemId: s.id,
            type: "related-to",
            origin: "ai",
            status: "suggested",
          });
          suggestions.push(s.id);
        }
      }
      if (suggestions.length) {
        await logEvent({
          entityType: "item",
          entityId: id,
          action: "links-suggested",
          summary: `Auto-suggested ${suggestions.length} possible relation(s) for "${input.name}"`,
          actor: "ai",
          payload: { suggestedItemIds: suggestions },
        });
      }
      return { id, suggestedRelations: suggestions.length };
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, attributes, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      if (attributes !== undefined) patch.attributes = attributes;
      await db.update(items).set(patch).where(eq(items.id, id));
      await logEvent({
        entityType: "item",
        entityId: id,
        action: "updated",
        summary: `Item #${id} updated (${Object.keys(patch).join(", ") || "no changes"})`,
        payload: patch as Record<string, unknown>,
      });
      return { ok: true };
    }),

  setArchived: publicQuery
    .input(z.object({ id: z.number(), archived: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(items)
        .set({
          status: input.archived ? "archived" : "active",
          archivedAt: input.archived ? new Date() : null,
        })
        .where(eq(items.id, input.id));
      await logEvent({
        entityType: "item",
        entityId: input.id,
        action: input.archived ? "archived" : "restored",
        summary: `Item #${input.id} ${input.archived ? "archived" : "restored"}`,
      });
      return { ok: true };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const item = await db.query.items.findFirst({ where: eq(items.id, input.id) });
    await db.delete(relations).where(
      or(eq(relations.fromItemId, input.id), eq(relations.toItemId, input.id)),
    );
    await db.delete(attachments).where(eq(attachments.itemId, input.id));
    await db.delete(ideaItems).where(eq(ideaItems.itemId, input.id));
    await db.delete(items).where(eq(items.id, input.id));
    await logEvent({
      entityType: "item",
      entityId: input.id,
      action: "deleted",
      summary: `Item "${item?.name ?? input.id}" deleted`,
    });
    return { ok: true };
  }),

  // ---- relations ----
  addRelation: publicQuery
    .input(
      z.object({
        fromItemId: z.number(),
        toItemId: z.number(),
        type: z.string().default("related-to"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(relations)
        .values({ ...input, origin: "user", status: "confirmed" })
        .$returningId();
      await logEvent({
        entityType: "relation",
        entityId: id,
        action: "created",
        summary: `Relation "${input.type}" created between items #${input.fromItemId} and #${input.toItemId}`,
      });
      return { id };
    }),

  resolveRelation: publicQuery
    .input(z.object({ id: z.number(), confirm: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      if (input.confirm) {
        await db.update(relations).set({ status: "confirmed" }).where(eq(relations.id, input.id));
      } else {
        await db.delete(relations).where(eq(relations.id, input.id));
      }
      await logEvent({
        entityType: "relation",
        entityId: input.id,
        action: input.confirm ? "confirmed" : "rejected",
        summary: `Suggested relation #${input.id} ${input.confirm ? "confirmed" : "rejected"}`,
      });
      return { ok: true };
    }),

  removeRelation: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(relations).where(eq(relations.id, input.id));
    await logEvent({
      entityType: "relation",
      entityId: input.id,
      action: "deleted",
      summary: `Relation #${input.id} removed`,
    });
    return { ok: true };
  }),

  /** lightweight search for pickers / auto-linking */
  search: publicQuery.input(z.object({ q: z.string() })).query(async ({ input }) => {
    const db = getDb();
    const all = await db.select().from(items).where(eq(items.status, "active"));
    const q = input.q.toLowerCase();
    return all
      .filter((i) => i.name.toLowerCase().includes(q))
      .slice(0, 10)
      .map((i) => ({ id: i.id, name: i.name, areaId: i.areaId }));
  }),
});
