import { z } from "zod";
import { desc, eq, and } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { events } from "@db/schema";

export const eventsRouter = createRouter({
  list: procedure
    .input(
      z
        .object({
          limit: z.number().max(500).default(100),
          entityType: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const q = getDb().select().from(events);
      return (input?.entityType ? q.where(eq(events.entityType, input.entityType)) : q)
        .orderBy(desc(events.createdAt))
        .limit(input?.limit ?? 100);
    }),

  forEntity: procedure
    .input(z.object({ entityType: z.string(), entityId: z.number() }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(events)
        .where(and(eq(events.entityType, input.entityType), eq(events.entityId, input.entityId)))
        .orderBy(desc(events.createdAt))
        .limit(100);
      return rows;
    }),
});
