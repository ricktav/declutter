import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { items, storageDirs, storageVolumes } from "@db/schema";
import { logEvent } from "../lib/events";
import {
  DATA_ROLES,
  MACHINE_ID_KEY,
  STORAGE_DISK_KEY,
  STORAGE_HIDDEN_KEY,
  STORAGE_STARRED_KEY,
  StorageReportError,
  applyReport,
  applyStorageViewFlag,
  isStorageComputer,
  isStorageDevice,
  machineIdentity,
  overviewFor,
  physicalDiskKey,
  removeVolume,
  storageViewFlags,
} from "../lib/storage";
import { applyTrackerImport } from "../lib/storageTracker";

const reportVolume = z.object({
  mountPoint: z.string().min(1).max(255),
  label: z.string().max(128).nullable().optional(),
  fsType: z.string().max(32).nullable().optional(),
  device: z.string().max(128).nullable().optional(),
  container: z.string().max(64).nullable().optional(),
  capacityBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  dirs: z.array(z.object({ path: z.string().min(1).max(512), bytes: z.number().int().nonnegative() })).max(100).optional(),
  measuredAt: z.union([z.string(), z.number(), z.date()]).optional(),
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

  removeVolume: procedure.input(z.object({ volumeId: z.number().int() })).mutation(async ({ input }) => {
    const removed = await removeVolume(getDb(), input.volumeId);
    if (!removed) throw new TRPCError({ code: "NOT_FOUND", message: "Volume not found." });
    await logEvent({
      entityType: "item",
      entityId: removed.itemId,
      action: "storage.volume.removed",
      summary: `${removed.mountPoint}: volume removed`,
      payload: { volumeId: input.volumeId, mountPoint: removed.mountPoint },
    });
    return { removed: true as const };
  }),

  overview: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      return overviewFor(getDb(), houseId);
    }),

  /**
   * Star or hide a machine (computer or NAS) on the Storage page. View-only:
   * the Thing and its volumes stay. `starred` / `hidden` write the
   * `storage.starred` / `storage.hidden` attributes (`yes` or removed).
   */
  setFlags: procedure
    .input(
      z
        .object({
          itemId: z.number().int(),
          starred: z.boolean().optional(),
          hidden: z.boolean().optional(),
        })
        .refine((v) => v.starred !== undefined || v.hidden !== undefined, { message: "Set starred or hidden." }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      if (!isStorageComputer(item)) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a machine." });
      const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
      const changed: string[] = [];
      if (input.starred !== undefined && applyStorageViewFlag(next, STORAGE_STARRED_KEY, input.starred)) {
        changed.push(input.starred ? `${STORAGE_STARRED_KEY} = yes` : `${STORAGE_STARRED_KEY} removed`);
      }
      if (input.hidden !== undefined && applyStorageViewFlag(next, STORAGE_HIDDEN_KEY, input.hidden)) {
        changed.push(input.hidden ? `${STORAGE_HIDDEN_KEY} = yes` : `${STORAGE_HIDDEN_KEY} removed`);
      }
      if (changed.length > 0) {
        await db
          .update(items)
          .set({ attributes: Object.keys(next).length > 0 ? next : null })
          .where(eq(items.id, input.itemId));
        await logEvent({
          entityType: "item",
          entityId: input.itemId,
          action: "storage.flags",
          summary: `${item.name}: ${changed.join(", ")}`,
        });
      }
      return { id: item.id, ...storageViewFlags(next) };
    }),

  /**
   * Preferred tracker hostname / IP / MAC for this machine (`machine.id`).
   * Null clears it. Must be one of the Thing's hostname, IP, MAC or aliases.
   */
  setIdentity: procedure
    .input(z.object({ itemId: z.number().int(), machineId: z.string().min(1).max(128).nullable() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      if (!isStorageComputer(item)) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a machine." });
      const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
      const ident = machineIdentity(next);
      if (input.machineId == null || input.machineId === "") {
        if (!(MACHINE_ID_KEY in next)) return { id: item.id, machineId: null as string | null };
        delete next[MACHINE_ID_KEY];
      } else {
        const allowed = new Set(ident.identityOptions.map((s) => s.toLowerCase()));
        if (!allowed.has(input.machineId.toLowerCase()) && ident.machineId?.toLowerCase() !== input.machineId.toLowerCase()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a hostname, IP, MAC or alias already on this machine." });
        }
        if (next[MACHINE_ID_KEY] === input.machineId) return { id: item.id, machineId: input.machineId };
        next[MACHINE_ID_KEY] = input.machineId;
      }
      await db
        .update(items)
        .set({ attributes: Object.keys(next).length > 0 ? next : null })
        .where(eq(items.id, input.itemId));
      await logEvent({
        entityType: "item",
        entityId: item.id,
        action: "storage.identity",
        summary: `${item.name}: ${MACHINE_ID_KEY} ${input.machineId == null ? "removed" : `= ${input.machineId}`}`,
      });
      return { id: item.id, machineId: input.machineId };
    }),

  /**
   * Pin a disk Thing to a kernel disk name (`sda`, `disk9`) so computer-attached
   * volumes with that `device` draw on it. Null clears the override.
   */
  setDiskLink: procedure
    .input(z.object({ itemId: z.number().int(), diskKey: z.string().min(1).max(64).nullable() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      if (!isStorageDevice(item) || String(item.attributes?.role ?? "") !== "storage") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not a disk." });
      }
      const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
      const key = input.diskKey == null ? null : physicalDiskKey(input.diskKey, input.diskKey) ?? input.diskKey.toLowerCase();
      const prev = next[STORAGE_DISK_KEY];
      if (key == null) {
        if (!(STORAGE_DISK_KEY in next)) return { id: item.id, diskKey: null as string | null };
        delete next[STORAGE_DISK_KEY];
      } else if (prev === key) {
        return { id: item.id, diskKey: key };
      } else {
        next[STORAGE_DISK_KEY] = key;
      }
      await db
        .update(items)
        .set({ attributes: Object.keys(next).length > 0 ? next : null })
        .where(eq(items.id, input.itemId));
      await logEvent({
        entityType: "item",
        entityId: input.itemId,
        action: "storage.disk",
        summary: `${item.name}: ${STORAGE_DISK_KEY} ${key == null ? "removed" : `= ${key}`}`,
      });
      return { id: item.id, diskKey: key };
    }),

  /**
   * Pull Data Tracker GET /api/sources (type=file) into storage.report.
   * Dry unless `dry` is false. Does not change storage.report's contract.
   */
  importSources: procedure
    .input(
      z.object({
        sources: z.unknown(),
        dry: z.boolean().optional(),
        hostMap: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await applyTrackerImport(getDb(), input);
      } catch (e) {
        if (e instanceof StorageReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
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
    return {
      volume: {
        id: volume.id,
        itemId: volume.itemId,
        itemName: item?.name ?? `#${volume.itemId}`,
        mountPoint: volume.mountPoint,
        label: volume.label,
        fsType: volume.fsType,
        device: volume.device,
        capacityBytes: volume.capacityBytes,
        usedBytes: volume.usedBytes,
        dataRole: volume.dataRole,
        measuredAt: volume.measuredAt,
        dirCount: dirs.length,
      },
      dirs,
    };
  }),
});
