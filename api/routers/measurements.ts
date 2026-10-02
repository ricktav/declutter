import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { measurements } from "@db/schema";
import { logEvent } from "../lib/events";

/**
 * Human-validated dimensions (laser/tape) against a room edge or item
 * footprint. A second data point the geometry stage can reconcile against —
 * never a silent overwrite of the scan-derived value.
 */
export const measurementsRouter = createRouter({
  listForTarget: procedure
    .input(z.object({ targetType: z.enum(["room", "item"]), targetId: z.number() }))
    .query(async ({ input }) => {
      return getDb()
        .select()
        .from(measurements)
        .where(
          and(eq(measurements.targetType, input.targetType), eq(measurements.targetId, input.targetId)),
        )
        .orderBy(desc(measurements.createdAt));
    }),

  record: procedure
    .input(
      z.object({
        targetType: z.enum(["room", "item"]),
        targetId: z.number(),
        field: z.string().optional(),
        valueM: z.number().positive(),
        method: z.enum(["laser", "tape", "scan"]),
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(measurements)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          field: input.field ?? null,
          valueM: input.valueM,
          method: input.method,
          note: input.note ?? null,
        })
        .$returningId();
      await logEvent({
        entityType: input.targetType,
        entityId: input.targetId,
        action: "measured",
        summary: `${input.method} measurement recorded${input.field ? ` for ${input.field}` : ""}: ${input.valueM}m`,
        payload: { measurementId: id, method: input.method, valueM: input.valueM },
      });
      return { id };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(measurements).where(eq(measurements.id, input.id));
    return { ok: true };
  }),
});
