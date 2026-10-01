import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items } from "@db/schema";
import type { AttributeDef } from "@db/schema";
import { logEvent } from "../lib/events";

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
  list: publicQuery
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

  get: publicQuery.input(z.object({ slug: z.string() })).query(async ({ input }) => {
    return getDb().query.areas.findFirst({ where: eq(areas.slug, input.slug) });
  }),

  create: publicQuery
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

  update: publicQuery
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
      await db.update(areas).set(patch).where(eq(areas.id, id));
      await logEvent({
        entityType: "area",
        entityId: id,
        action: "updated",
        summary: `Area #${id} updated (${Object.keys(patch).join(", ")})`,
        payload: patch,
      });
      return db.query.areas.findFirst({ where: eq(areas.id, id) });
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const area = await db.query.areas.findFirst({ where: eq(areas.id, input.id) });
    await db.delete(items).where(eq(items.areaId, input.id));
    await db.delete(areas).where(eq(areas.id, input.id));
    await logEvent({
      entityType: "area",
      entityId: input.id,
      action: "deleted",
      summary: `Area "${area?.name ?? input.id}" and its items deleted`,
    });
    return { ok: true };
  }),
});
