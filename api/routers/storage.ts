import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { items, storageDirs, storageVolumes } from "@db/schema";
import { logEvent } from "../lib/events";
import { DATA_ROLES, StorageReportError, applyReport, overviewFor } from "../lib/storage";

const reportVolume = z.object({
  mountPoint: z.string().min(1).max(255),
  label: z.string().max(128).nullable().optional(),
  fsType: z.string().max(32).nullable().optional(),
  device: z.string().max(128).nullable().optional(),
  capacityBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  dirs: z.array(z.object({ path: z.string().min(1).max(512), bytes: z.number().int().nonnegative() })).max(100).optional(),
});

/**
 * Measured storage: volumes with capacity and use per device, their biggest
 * directories, and a data role per volume that rolls up to totals. Reports
 * come from collectors (scripts/storage-report-local.mjs, the Data Tracker).
 */
export const storageRouter = createRouter({
  report: procedure
    .input(z.object({ itemId: z.number().int(), source: z.string().min(1).max(32), volumes: z.array(reportVolume).min(1).max(64) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      try {
        const result = await applyReport(db, input);
        await logEvent({
          entityType: "item",
          entityId: input.itemId,
          action: "storage.report",
          summary: `${input.source} reported ${result.volumes} volume(s)`,
          payload: { source: input.source, volumes: input.volumes.map((v) => v.mountPoint) },
        });
        return result;
      } catch (e) {
        if (e instanceof StorageReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),

  setRole: procedure
    .input(z.object({ volumeId: z.number().int(), dataRole: z.enum(DATA_ROLES).nullable() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.storageVolumes.findFirst({ where: eq(storageVolumes.id, input.volumeId) });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found." });
      if (row.dataRole === input.dataRole) return row;
      await db.update(storageVolumes).set({ dataRole: input.dataRole }).where(eq(storageVolumes.id, input.volumeId));
      await logEvent({
        entityType: "item",
        entityId: row.itemId,
        action: "storage.role",
        summary: `${row.mountPoint}: data role ${row.dataRole ?? "none"} → ${input.dataRole ?? "none"}`,
      });
      return { ...row, dataRole: input.dataRole };
    }),

  overview: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      return overviewFor(getDb(), houseId);
    }),

  dirs: procedure.input(z.object({ volumeId: z.number().int() })).query(async ({ input }) => {
    const db = getDb();
    const volume = await db.query.storageVolumes.findFirst({ where: eq(storageVolumes.id, input.volumeId) });
    if (!volume) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found." });
    const item = await db.query.items.findFirst({ where: eq(items.id, volume.itemId) });
    const dirs = await db
      .select({ path: storageDirs.path, bytes: storageDirs.bytes, measuredAt: storageDirs.measuredAt })
      .from(storageDirs)
      .where(eq(storageDirs.volumeId, input.volumeId))
      .orderBy(desc(storageDirs.bytes));
    return { volume: { ...volume, itemName: item?.name ?? `#${volume.itemId}` }, dirs };
  }),
});
