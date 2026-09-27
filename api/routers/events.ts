import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { events } from "@db/schema";

export const eventsRouter = createRouter({
  list: publicQuery
    .input(
      z
        .object({
          limit: z.number().max(500).default(100),
          entityType: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const base = db.select().from(events).orderBy(desc(events.createdAt)).limit(input?.limit ?? 100);
      const rows = await base;
      return input?.entityType ? rows.filter((r) => r.entityType === input.entityType) : rows;
    }),

  forEntity: publicQuery
    .input(z.object({ entityType: z.string(), entityId: z.number() }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(events)
        .where(eq(events.entityType, input.entityType))
        .orderBy(desc(events.createdAt))
        .limit(100);
      return rows.filter((r) => r.entityId === input.entityId);
    }),
});
