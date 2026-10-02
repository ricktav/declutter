import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items } from "@db/schema";
import type { AttributeDef } from "@db/schema";
import { logEvent } from "../lib/events";
import { deleteItemTx, releaseStoredFiles } from "../lib/entities";

const attributeDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "select"]),
  options: z.array(z.string()).optional(),
});

export const areasRouter = createRouter({
  // optional houseId scopes the item counts to just that house - the
  // Dashboard uses this so "working in" a house also means its topic
  // breakdown reflects that house instead of the whole inventory
  list: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const all = await db.select().from(areas).orderBy(areas.sortOrder, areas.id);
      const counts = await db
        .select({ areaId: items.areaId, count: sql<number>`count(*)` })
        .from(items)
        .where(
          input?.houseId != null
            ? and(eq(items.status, "active"), eq(items.houseId, input.houseId))
            : eq(items.status, "active"),
        )
        .groupBy(items.areaId);
      const countMap = new Map(counts.map((c) => [c.areaId, Number(c.count)]));
      return all.map((a) => ({ ...a, itemCount: countMap.get(a.id) ?? 0 }));
    }),

  get: procedure.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    return getDb().query.areas.findFirst({ where: eq(areas.slug, input.slug) });
  }),

  create: procedure
    .input(
      z.object({
        name: z.string().min(1),
        slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
        icon: z.string().default("box"),
        color: z.string().default("#6366f1"),
        description: z.string().optional(),
        attributeDefs: z.array(attributeDefSchema).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(areas)
        .values({
          name: input.name,
          slug: input.slug,
          icon: input.icon,
          color: input.color,
          description: input.description ?? null,
          attributeDefs: (input.attributeDefs as AttributeDef[]) ?? null,
        })
        .$returningId();
      await logEvent({
        entityType: "area",
        entityId: id,
        action: "created",
        summary: `Area "${input.name}" created`,
      });
      return db.query.areas.findFirst({ where: eq(areas.id, id) });
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/)
          .optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
        description: z.string().nullable().optional(),
        attributeDefs: z.array(attributeDefSchema).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...rest } = input;
      if (rest.slug) {
        const clash = await db.query.areas.findFirst({ where: eq(areas.slug, rest.slug) });
        if (clash && clash.id !== id) {
          throw new Error(`Slug "${rest.slug}" is already used by area "${clash.name}".`);
        }
      }
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;

      // fetch the pre-update row so the history entry can name what actually
      // changed instead of just listing which field keys were touched
      const before = await db.query.areas.findFirst({ where: eq(areas.id, id) });
      await db.update(areas).set(patch).where(eq(areas.id, id));

      const subject = before?.name ?? `#${id}`;
      const parts: string[] = [];
      if (patch.name !== undefined && patch.name !== before?.name) {
        parts.push(`renamed from "${before?.name ?? "?"}" to "${patch.name}"`);
      }
      if (patch.slug !== undefined && patch.slug !== before?.slug) {
        parts.push(`slug changed to "${patch.slug}"`);
      }
      if (patch.icon !== undefined) parts.push("icon changed");
      if (patch.color !== undefined) parts.push("color changed");
      if (patch.description !== undefined) parts.push("description updated");
      if (patch.attributeDefs !== undefined) parts.push("attribute fields updated");

      await logEvent({
        entityType: "area",
        entityId: id,
        action: "updated",
        summary: parts.length
          ? `Area "${subject}" ${parts.join(", ")}`
          : `Area "${subject}" updated (no changes)`,
        payload: patch,
      });
      return db.query.areas.findFirst({ where: eq(areas.id, id) });
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const area = await db.query.areas.findFirst({ where: eq(areas.id, input.id) });
    const files = await db.transaction(async (tx) => {
      const rows = await tx.select({ id: items.id }).from(items).where(eq(items.areaId, input.id));
      const keys: string[] = [];
      for (const r of rows) keys.push(...(await deleteItemTx(tx, r.id)));
      await tx.delete(areas).where(eq(areas.id, input.id));
      await logEvent(
        {
          entityType: "area",
          entityId: input.id,
          action: "deleted",
          summary: `Area "${area?.name ?? input.id}" and its ${rows.length} item(s) deleted`,
        },
        tx,
      );
      return keys;
    });
    await releaseStoredFiles(db, files);
    return { ok: true };
  }),
});
