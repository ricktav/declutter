# Storage Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Workbench page that draws every computer with its disks and volumes as blocks sized by capacity and filled by use, opens the biggest top-level directories of a volume on click, lets Rick assign a data role (unique, test, backup, archive, …) to a volume in one click, and rolls capacity and use up per data role; fed by a collector that any machine can run.

**Architecture:** Two new tables carry what the inventory lacks: `storage_volumes` (one row per mounted volume on a device item, with measured capacity and use, a data role and a timestamp) and `storage_dirs` (the biggest top-level directories of a volume at the last measurement). Devices stay what they are today: computer items and their internal drives (`role: storage`, `parentId` = the computer) or external drives and NAS boxes (no parent). A `storage` tRPC router ingests collector reports (`storage.report`), serves the tree (`storage.overview`), the directories (`storage.dirs`) and the role change (`storage.setRole`). A collector script measures this Mac with `df` and `du` and posts a report; the same contract is what the Data Tracker on prodesk-rt1 will send for the other machines.

**Tech Stack:** Hono + tRPC 11 (superjson) + Drizzle ORM on MySQL 8 (`db/schema.ts`, drizzle-kit migrations), React 19 + Tailwind + lucide icons (Workbench, `src/pages`), vitest against `declutter_test` through the `api/test` seam, Node 20 scripts.

**Spec:** Rick's request of 2026-10-04 in this session ("block visualizations … computers, with their disks/volumes as blocks, internal, external, showing their capacity and usage/free space. Clicking should give their biggest top dirs. Quick assignment of role (unique, test, backup, archive, etc) should be possible and roll up to category total/inventory") plus the data facts gathered the same day: 24 computers, 20 storage devices (14 internal by `parentId`), `storage_gb` on most, `storage_free_gb` on few, no volumes, no directories, `role` means device kind.

## Global Constraints

- AGENTS.md §2: every existing procedure keeps its inputs and outputs; this plan only adds a router, two tables and one page. The lab attribute keys `storage_gb`, `storage_free_gb`, `mount_point`, `drive_type`, `role` keep their meaning (device kind), so the data role gets its own column, never an attribute.
- AGENTS.md §3: schema changes only in `db/schema.ts` + `npm run db:generate -- --name <name>`; the migration is additive (two new tables), so it is applied to the test database, then to the live one, then Rick is told. No destructive step anywhere.
- AGENTS.md §4: work in a worktree (`/Volumes/T7/declutter-storage`, branch `storage-overview`), one commit per task, merge to `main` by fast-forward only when Rick says so (he said "plan and implement"; the merge and the deploy restart are still reported to him, the restart is his to run).
- Tests: seam only (`api/test/db.ts`, `callerFor`, `resetTestDb`), never `DATABASE_URL`; the suite truncates `declutter_test`, so no dev server on the test database runs during `npm test`. Baselines: 110 tests, eslint 31 problems on `api src scripts`, `npm run check` and `npm run build` clean.
- Sizes are bytes as JavaScript numbers (MySQL `BIGINT`, Drizzle `mode: "number"`); every number the API returns is bytes, the UI formats. A collector sends bytes.
- Data roles are a fixed list: `unique`, `test`, `backup`, `archive`, `system`, `media`, `scratch`. Unassigned is `null`. Adding a role is a one-line change in `api/lib/storage.ts` (`DATA_ROLES`).
- No new npm dependencies.
- Production :3001 is restarted by Rick only.

## Review Focus

1. A report for a volume that disappeared (unmounted drive): its row must stay with its last measurement, not be deleted, and the overview marks it stale by `measuredAt`. Test in Task 2 ("a volume missing from a later report keeps its last measurement").
2. A report naming an item that is not a storage device or computer (a chair): refused with `BAD_REQUEST`, nothing written. Test in Task 2.
3. Two volumes with the same mount point on two different devices (`/` on every computer): keyed by (itemId, mountPoint), never merged. Test in Task 2 ("same mount point on two devices stays two volumes").
4. Role totals must count a volume once even when its device is both a computer's child and listed in the externals (a drive can only have one parent, but the overview groups internal under the computer and the rest under externals; the totals query sums `storage_volumes` directly). Test in Task 3 ("totals sum every volume once").
5. A drive with no volume report yet must still draw a block from `storage_gb`/`storage_free_gb`, labelled as unmeasured, so the page is useful on day one. Test in Task 3 ("a device without volumes falls back to its attributes").

---

## File structure

| File | Responsibility |
|---|---|
| `db/schema.ts` | add `storageVolumes`, `storageDirs` |
| `db/migrations/0007_storage_volumes.sql` + meta | generated |
| `api/lib/storage.ts` | `DATA_ROLES`, `isStorageDevice`, `applyReport`, `overviewFor`, `roleTotals` (pure DB functions, no tRPC) |
| `api/routers/storage.ts` | `storage.report`, `storage.overview`, `storage.dirs`, `storage.setRole` |
| `api/router.ts` | register `storage` |
| `api/test/storage.test.ts` | seam tests |
| `scripts/storage-report-local.mjs` | collector for the machine it runs on (df + du), posts to `storage.report` |
| `src/pages/Storage.tsx` | the page: role totals bar, computers with drive blocks, externals, volume panel |
| `src/components/storage/Blocks.tsx` | `DeviceBlock`, `VolumeSegment`, `formatBytes` (pure presentational) |
| `src/App.tsx`, `src/components/Layout.tsx` | route `/storage`, nav entry |
| `AGENTS.md` §2 | the collector contract (`storage.report`) and the new reads |

---

### Task 1: Tables and migration

**Files:**
- Modify: `db/schema.ts` (append after `measurements`)
- Create: `db/migrations/0007_storage_volumes.sql`, snapshot, journal (generated)
- Test: `api/test/storage.test.ts` (first test only: the tables exist)

**Interfaces:**
- Produces: `storageVolumes` columns `id, itemId, mountPoint, label, fsType, device, capacityBytes, usedBytes, dataRole, source, measuredAt, createdAt`; `storageDirs` columns `id, volumeId, path, bytes, measuredAt`; type `DataRole`.

- [ ] **Step 1: Worktree**

```bash
cd /Volumes/T7/declutter && git fetch -q origin && git worktree add /Volumes/T7/declutter-storage -b storage-overview main && cd /Volumes/T7/declutter-storage && npm install --no-audit --no-fund 2>&1 | tail -1 && cp /Volumes/T7/declutter/.env .env && npm test 2>&1 | grep -E "Tests "
```

Expected: `Tests  110 passed (110)`.

- [ ] **Step 2: Write the failing test**

Create `api/test/storage.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTestDb, resetTestDb } from "./db";

beforeEach(resetTestDb);

describe("storage tables", () => {
  it("exist with their key columns", async () => {
    const db = getTestDb();
    const [cols] = (await db.execute(
      sql`select table_name t, column_name c from information_schema.columns where table_schema = database() and table_name in ('storage_volumes','storage_dirs') order by 1, ordinal_position`,
    )) as unknown as [{ t: string; c: string }[]];
    const by = (t: string) => cols.filter((r) => r.t === t).map((r) => r.c);
    expect(by("storage_volumes")).toEqual(
      expect.arrayContaining(["id", "itemId", "mountPoint", "capacityBytes", "usedBytes", "dataRole", "measuredAt"]),
    );
    expect(by("storage_dirs")).toEqual(expect.arrayContaining(["id", "volumeId", "path", "bytes", "measuredAt"]));
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run api/test/storage.test.ts`
Expected: FAIL (empty arrays: the tables do not exist).

- [ ] **Step 4: Schema**

Append to `db/schema.ts` after the `measurements` table:

```typescript
// ---------------------------------------------------------------------------
// Storage volumes — one row per mounted volume on a device item (an internal
// drive, an external drive, a NAS or, when the collector cannot tell which
// drive, the computer itself). Bytes, measured by a collector (df); the data
// role is Rick's call and survives every report. A volume that stops being
// reported keeps its last measurement; the UI shows its age.
// ---------------------------------------------------------------------------
export type DataRole = "unique" | "test" | "backup" | "archive" | "system" | "media" | "scratch";

export const storageVolumes = mysqlTable(
  "storage_volumes",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }).notNull(),
    mountPoint: varchar("mountPoint", { length: 255 }).notNull(),
    label: varchar("label", { length: 128 }),
    fsType: varchar("fsType", { length: 32 }),
    device: varchar("device", { length: 128 }),
    capacityBytes: bigint("capacityBytes", { mode: "number" }).notNull(),
    usedBytes: bigint("usedBytes", { mode: "number" }).notNull(),
    dataRole: varchar("dataRole", { length: 16 }).$type<DataRole>(),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    measuredAt: timestamp("measuredAt").notNull().defaultNow(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sv_item_mount_uq").on(t.itemId, t.mountPoint), index("sv_role_idx").on(t.dataRole)],
);

// The biggest top-level directories of a volume at its last measurement (du).
// Replaced wholesale on every report that carries directories.
export const storageDirs = mysqlTable(
  "storage_dirs",
  {
    id: serial("id").primaryKey(),
    volumeId: bigint("volumeId", { mode: "number", unsigned: true }).notNull(),
    path: varchar("path", { length: 512 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    measuredAt: timestamp("measuredAt").notNull().defaultNow(),
  },
  (t) => [index("sd_volume_idx").on(t.volumeId)],
);
```

- [ ] **Step 5: Generate and read the migration**

```bash
cd /Volumes/T7/declutter-storage && npm run db:generate -- --name storage_volumes 2>&1 | tail -3 && cat db/migrations/0007_storage_volumes.sql
```

Expected: two `CREATE TABLE` statements, one unique index `sv_item_mount_uq`, two plain indexes, nothing else (no ALTER on existing tables). If drizzle-kit emits anything touching another table, stop and report.

- [ ] **Step 6: Apply to the test database and run the test**

```bash
cd /Volumes/T7/declutter-storage && TEST_URL="$(node -e 'require("dotenv").config({ quiet: true }); process.stdout.write(process.env.TEST_DATABASE_URL)')" && DATABASE_URL="$TEST_URL" npm run db:migrate 2>&1 | tail -2 && npx vitest run api/test/storage.test.ts
```

Expected: migration applied to `declutter_test`; PASS.

- [ ] **Step 7: Apply to the live database (additive) and tell Rick**

```bash
cd /Volumes/T7/declutter-storage && npm run db:migrate 2>&1 | tail -2 && node -e 'require("dotenv").config({quiet:true});const m=require("mysql2/promise");(async()=>{const c=await m.createConnection({uri:process.env.DATABASE_URL});const [r]=await c.query("select table_name t from information_schema.tables where table_schema=database() and table_name like \"storage_%\"");console.log(r);await c.end()})()'
```

Expected: both tables listed. Record the line "0007 applied to live <timestamp>" in the ledger; the controller tells Rick in its report.

- [ ] **Step 8: Gates and commit**

```bash
cd /Volumes/T7/declutter-storage && npm run check && npx eslint api src scripts 2>&1 | tail -1 && npm test 2>&1 | grep -E "Tests " && git add db api/test/storage.test.ts && git commit -m "Storage volumes and directories: two tables for measured capacity, use and data role

The inventory knew drives but not what is on them: capacity on most
devices, free space on a few, no volumes, no directories, and 'role'
means the kind of device. storage_volumes holds one row per mounted
volume with measured bytes and a data role of its own; storage_dirs the
biggest top-level directories at the last measurement. Additive, applied
to the test and the live database."
```

---

### Task 2: Ingest a collector report

**Files:**
- Create: `api/lib/storage.ts`
- Create: `api/routers/storage.ts` (only `report` in this task)
- Modify: `api/router.ts`
- Test: `api/test/storage.test.ts`

**Interfaces:**
- Produces: `DATA_ROLES: readonly DataRole[]`; `isStorageDevice(item): boolean`; `applyReport(db, input: ReportInput): Promise<{ volumes: number; dirs: number }>` where `ReportInput = { itemId: number; source: string; volumes: Array<{ mountPoint: string; label?: string | null; fsType?: string | null; device?: string | null; capacityBytes: number; usedBytes: number; dirs?: Array<{ path: string; bytes: number }> }> }`; tRPC `storage.report(ReportInput)` → `{ volumes, dirs }`.
- Consumes: Task 1 tables.

- [ ] **Step 1: Write the failing tests**

Append to `api/test/storage.test.ts` (add imports `areas, houses, items, storageDirs, storageVolumes` from `@db/schema`, `eq` from `drizzle-orm`, `callerFor` from `./caller`):

```typescript
async function seedDevices() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: pc }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "mac-mini", attributes: { role: "desktop", storage_gb: 1000, storage_free_gb: 400 } })
    .$returningId();
  const [{ id: ssd }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "Internal SSD", parentId: pc, attributes: { role: "storage", drive_type: "nvme", storage_gb: 1000 } })
    .$returningId();
  const [{ id: nas }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "synology-nas", attributes: { role: "nas", storage_gb: 3933, storage_free_gb: 426 } })
    .$returningId();
  const [{ id: chair }] = await db.insert(items).values({ areaId, houseId, name: "Stoel", attributes: { role: "furniture" } }).$returningId();
  return { areaId, houseId, pc, ssd, nas, chair };
}

const GB = 1024 ** 3;

describe("storage.report", () => {
  it("creates volumes and directories for a drive and updates them on the next report", async () => {
    const { houseId, ssd } = await seedDevices();
    const c = callerFor(houseId);
    const first = await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [
        { mountPoint: "/", label: "Macintosh HD", fsType: "apfs", device: "disk3s1", capacityBytes: 994 * GB, usedBytes: 600 * GB, dirs: [{ path: "/Users", bytes: 500 * GB }, { path: "/Applications", bytes: 40 * GB }] },
        { mountPoint: "/Volumes/Data", capacityBytes: 994 * GB, usedBytes: 10 * GB },
      ],
    });
    expect(first).toEqual({ volumes: 2, dirs: 2 });
    const rows = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd));
    expect(rows.map((r) => [r.mountPoint, r.usedBytes, r.dataRole])).toEqual([
      ["/", 600 * GB, null],
      ["/Volumes/Data", 10 * GB, null],
    ]);

    await c.storage.setRole({ volumeId: rows[0].id, dataRole: "unique" });
    const second = await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [{ mountPoint: "/", capacityBytes: 994 * GB, usedBytes: 650 * GB, dirs: [{ path: "/Users", bytes: 550 * GB }] }],
    });
    expect(second).toEqual({ volumes: 1, dirs: 1 });
    const after = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd)).orderBy(storageVolumes.mountPoint);
    expect(after.map((r) => [r.mountPoint, r.usedBytes, r.dataRole])).toEqual([
      ["/", 650 * GB, "unique"], // role survives, use updated
      ["/Volumes/Data", 10 * GB, null], // missing from the later report: kept with its last measurement
    ]);
    expect(after[0].measuredAt.getTime()).toBeGreaterThanOrEqual(after[1].measuredAt.getTime());
    const dirs = await getTestDb().select().from(storageDirs).where(eq(storageDirs.volumeId, rows[0].id));
    expect(dirs.map((d) => [d.path, d.bytes])).toEqual([["/Users", 550 * GB]]); // replaced wholesale
  });

  it("keeps the same mount point on two devices as two volumes", async () => {
    const { houseId, pc, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: pc, source: "test", volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1 }] });
    await c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 2 * GB, usedBytes: 2 }] });
    const rows = await getTestDb().select().from(storageVolumes);
    expect(rows.map((r) => [r.itemId, r.capacityBytes]).sort((a, b) => a[0] - b[0])).toEqual([
      [pc, GB],
      [nas, 2 * GB],
    ]);
  });

  it("refuses a report for an item that is not a storage device or computer", async () => {
    const { houseId, chair } = await seedDevices();
    await expect(
      callerFor(houseId).storage.report({ itemId: chair, source: "test", volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await getTestDb().select().from(storageVolumes)).toHaveLength(0);
  });

  it("refuses used above capacity and keeps the device attributes in step", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await expect(
      c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/volume1", capacityBytes: GB, usedBytes: 2 * GB }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await c.storage.report({
      itemId: nas,
      source: "test",
      volumes: [
        { mountPoint: "/volume1", capacityBytes: 3000 * GB, usedBytes: 2000 * GB },
        { mountPoint: "/volume2", capacityBytes: 1000 * GB, usedBytes: 100 * GB },
      ],
    });
    const item = await getTestDb().query.items.findFirst({ where: eq(items.id, nas) });
    // the lab keys stay meaningful: whole-device GB, rounded, from the sum of the volumes
    expect(item?.attributes?.storage_gb).toBe(Math.round((4000 * GB) / 1e9));
    expect(item?.attributes?.storage_free_gb).toBe(Math.round((1900 * GB) / 1e9));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run api/test/storage.test.ts`
Expected: FAIL (`storage` is not on the router).

- [ ] **Step 3: The library**

Create `api/lib/storage.ts`:

```typescript
import { and, eq, inArray, sql } from "drizzle-orm";
import { items, storageDirs, storageVolumes, type DataRole } from "@db/schema";
import type { DbLike } from "./events";

export const DATA_ROLES = ["unique", "test", "backup", "archive", "system", "media", "scratch"] as const satisfies readonly DataRole[];

/** Roles that mean "this item can hold volumes": computers and the drives/NAS around them. */
const DEVICE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas", "storage"]);

export function isStorageDevice(item: { attributes: Record<string, string | number> | null }): boolean {
  const role = item.attributes?.role;
  return typeof role === "string" && DEVICE_ROLES.has(role);
}

export type ReportVolume = {
  mountPoint: string;
  label?: string | null;
  fsType?: string | null;
  device?: string | null;
  capacityBytes: number;
  usedBytes: number;
  dirs?: Array<{ path: string; bytes: number }>;
};

export type ReportInput = { itemId: number; source: string; volumes: ReportVolume[] };

export class StorageReportError extends Error {}

/**
 * Upsert the reported volumes of one device (keyed by itemId + mountPoint),
 * replace their directory lists when the report carries them, and keep the
 * device's lab keys (storage_gb, storage_free_gb) equal to the sum of all its
 * known volumes. Volumes absent from this report keep their last measurement
 * and their data role; a data role is never touched by a report.
 */
export async function applyReport(db: DbLike, input: ReportInput): Promise<{ volumes: number; dirs: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new StorageReportError("Item not found.");
  if (!isStorageDevice(item)) throw new StorageReportError("Not a computer, drive or NAS: give the report a storage device.");
  for (const v of input.volumes) {
    if (v.usedBytes > v.capacityBytes) throw new StorageReportError(`${v.mountPoint}: used (${v.usedBytes}) above capacity (${v.capacityBytes}).`);
  }
  const now = new Date();
  let dirCount = 0;
  await db.transaction(async (tx) => {
    for (const v of input.volumes) {
      await tx
        .insert(storageVolumes)
        .values({
          itemId: input.itemId,
          mountPoint: v.mountPoint,
          label: v.label ?? null,
          fsType: v.fsType ?? null,
          device: v.device ?? null,
          capacityBytes: v.capacityBytes,
          usedBytes: v.usedBytes,
          source: input.source,
          measuredAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            label: v.label ?? null,
            fsType: v.fsType ?? null,
            device: v.device ?? null,
            capacityBytes: v.capacityBytes,
            usedBytes: v.usedBytes,
            source: input.source,
            measuredAt: now,
          },
        });
      if (v.dirs) {
        const row = await tx.query.storageVolumes.findFirst({
          where: and(eq(storageVolumes.itemId, input.itemId), eq(storageVolumes.mountPoint, v.mountPoint)),
        });
        if (!row) throw new StorageReportError(`${v.mountPoint}: volume row missing after upsert.`);
        await tx.delete(storageDirs).where(eq(storageDirs.volumeId, row.id));
        if (v.dirs.length > 0) {
          await tx.insert(storageDirs).values(v.dirs.map((d) => ({ volumeId: row.id, path: d.path, bytes: d.bytes, measuredAt: now })));
          dirCount += v.dirs.length;
        }
      }
    }
    // keep the whole-device lab keys in step with every volume we know
    const all = await tx.select().from(storageVolumes).where(eq(storageVolumes.itemId, input.itemId));
    const capacity = all.reduce((s, r) => s + r.capacityBytes, 0);
    const used = all.reduce((s, r) => s + r.usedBytes, 0);
    await tx
      .update(items)
      .set({
        attributes: {
          ...(item.attributes ?? {}),
          storage_gb: Math.round(capacity / 1e9),
          storage_free_gb: Math.round((capacity - used) / 1e9),
        },
      })
      .where(eq(items.id, input.itemId));
  });
  return { volumes: input.volumes.length, dirs: dirCount };
}

/** Capacity and use per data role over every volume, plus the unassigned rest. */
export async function roleTotals(db: DbLike) {
  const rows = await db
    .select({
      dataRole: storageVolumes.dataRole,
      volumes: sql<number>`count(*)`,
      capacityBytes: sql<number>`sum(${storageVolumes.capacityBytes})`,
      usedBytes: sql<number>`sum(${storageVolumes.usedBytes})`,
    })
    .from(storageVolumes)
    .groupBy(storageVolumes.dataRole);
  return rows.map((r) => ({
    dataRole: r.dataRole ?? null,
    volumes: Number(r.volumes),
    capacityBytes: Number(r.capacityBytes),
    usedBytes: Number(r.usedBytes),
  }));
}

export async function volumesForItems(db: DbLike, itemIds: number[]) {
  if (itemIds.length === 0) return [];
  const vols = await db.select().from(storageVolumes).where(inArray(storageVolumes.itemId, itemIds)).orderBy(storageVolumes.mountPoint);
  const counts = vols.length
    ? await db
        .select({ volumeId: storageDirs.volumeId, n: sql<number>`count(*)` })
        .from(storageDirs)
        .where(inArray(storageDirs.volumeId, vols.map((v) => v.id)))
        .groupBy(storageDirs.volumeId)
    : [];
  const dirCount = new Map(counts.map((c) => [c.volumeId, Number(c.n)]));
  return vols.map((v) => ({ ...v, dirCount: dirCount.get(v.id) ?? 0 }));
}
```

Check `DbLike` in `api/lib/events.ts`: it must allow `.query`, `.transaction`, `.select`, `.insert`, `.update`, `.delete`. If it is narrower, import the DB type the way `api/lib/photos.ts` does (`type Db = ReturnType<typeof getDb>`) and use that instead of `DbLike`; keep the function signatures otherwise.

- [ ] **Step 4: The router (report and setRole only)**

Create `api/routers/storage.ts`:

```typescript
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { storageVolumes } from "@db/schema";
import { logEvent } from "../lib/events";
import { DATA_ROLES, StorageReportError, applyReport } from "../lib/storage";

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
});
```

Register in `api/router.ts`: `import { storageRouter } from "./routers/storage";` and `storage: storageRouter,` in `createRouter({ … })`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run api/test/storage.test.ts`
Expected: PASS (5 tests). If the `onDuplicateKeyUpdate` + `findFirst` pair fails on `measuredAt` ordering in the first test, both rows share `now` only within one report; the kept volume has the older timestamp, so the `>=` assertion holds.

- [ ] **Step 6: Gates and commit**

```bash
cd /Volumes/T7/declutter-storage && npm run check && npx eslint api src scripts 2>&1 | tail -1 && npm test 2>&1 | grep -E "Tests " && git add api && git commit -m "storage.report and storage.setRole: collectors write measured volumes, Rick assigns the data role

A report upserts volumes by (device, mount point), replaces the
directory list when it carries one, keeps absent volumes with their last
measurement, never touches a data role, and keeps the device's
storage_gb/storage_free_gb equal to the sum of its volumes so the lab
lens stays right. Only computers, drives and NAS boxes accept reports."
```

---

### Task 3: The overview and the directory list

**Files:**
- Modify: `api/routers/storage.ts` (add `overview`, `dirs`)
- Modify: `api/lib/storage.ts` (add `overviewFor`)
- Test: `api/test/storage.test.ts`

**Interfaces:**
- Produces: `storage.overview({ houseId?: number | null })` → `{ computers: Computer[]; externals: Device[]; totals: RoleTotal[]; unassignedVolumes: number }` where `Device = { id, name, kind: string, driveType: string | null, parentId: number | null, roomName: string | null, capacityBytes: number | null, usedBytes: number | null, measured: boolean, volumes: Volume[] }`, `Computer = Device & { drives: Device[] }`, `Volume = { id, mountPoint, label, fsType, device, capacityBytes, usedBytes, dataRole, measuredAt, dirCount }`, `RoleTotal = { dataRole: DataRole | null, volumes, capacityBytes, usedBytes }`; `storage.dirs({ volumeId })` → `{ volume: Volume & { itemId, itemName }, dirs: Array<{ path, bytes, measuredAt }> }` sorted by bytes desc.
- Consumes: Task 2 `volumesForItems`, `roleTotals`.

- [ ] **Step 1: Write the failing tests**

Append to `api/test/storage.test.ts`:

```typescript
describe("storage.overview", () => {
  it("groups internal drives under their computer, externals apart, and falls back to attributes", async () => {
    const { houseId, pc, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 1000 * GB, usedBytes: 600 * GB }] });
    const o = await c.storage.overview({});
    expect(o.computers.map((x) => x.name)).toEqual(["mac-mini"]);
    const mini = o.computers[0];
    expect(mini.drives.map((d) => [d.name, d.measured, d.usedBytes])).toEqual([["Internal SSD", true, 600 * GB]]);
    expect(mini.drives[0].volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    // the computer itself has no volumes: block from its attributes, unmeasured
    expect([mini.measured, mini.capacityBytes, mini.usedBytes]).toEqual([false, 1000e9, 600e9]);
    const ext = o.externals.find((d) => d.id === nas)!;
    expect([ext.kind, ext.measured, ext.capacityBytes, ext.usedBytes]).toEqual(["nas", false, 3933e9, (3933 - 426) * 1e9]);
    expect(o.externals.map((d) => d.id)).not.toContain(pc);
    expect(o.externals.map((d) => d.id)).not.toContain(ssd);
  });

  it("totals sum every volume once and count the unassigned ones", async () => {
    const { houseId, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB }] });
    await c.storage.report({
      itemId: nas,
      source: "test",
      volumes: [
        { mountPoint: "/volume1", capacityBytes: 20 * GB, usedBytes: 15 * GB },
        { mountPoint: "/volume2", capacityBytes: 30 * GB, usedBytes: 1 * GB },
      ],
    });
    const vols = await getTestDb().select().from(storageVolumes);
    const v1 = vols.find((v) => v.mountPoint === "/volume1")!;
    await c.storage.setRole({ volumeId: v1.id, dataRole: "backup" });
    await c.storage.setRole({ volumeId: vols.find((v) => v.mountPoint === "/")!.id, dataRole: "backup" });
    const o = await c.storage.overview({});
    const backup = o.totals.find((t) => t.dataRole === "backup")!;
    expect([backup.volumes, backup.capacityBytes, backup.usedBytes]).toEqual([2, 30 * GB, 19 * GB]);
    expect(o.totals.find((t) => t.dataRole === null)).toMatchObject({ volumes: 1, capacityBytes: 30 * GB, usedBytes: 1 * GB });
    expect(o.unassignedVolumes).toBe(1);
  });

  it("scopes to the context house but houseId null covers every house", async () => {
    const { pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "Zomerhuis" }).$returningId();
    const areaId = (await db.query.areas.findFirst())!.id;
    await db.insert(items).values({ areaId, houseId: h2, name: "pi-zomer", attributes: { role: "sbc" } });
    expect((await callerFor(h2).storage.overview({})).computers.map((c) => c.name)).toEqual(["pi-zomer"]);
    expect((await callerFor(h2).storage.overview({ houseId: null })).computers.map((c) => c.name).sort()).toEqual(["mac-mini", "pi-zomer"]);
    expect((await callerFor(null).storage.overview({})).computers.map((c) => c.id)).toContain(pc);
  });
});

describe("storage.dirs", () => {
  it("lists a volume's directories biggest first with its device", async () => {
    const { houseId, ssd } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB, dirs: [{ path: "/Applications", bytes: 1 * GB }, { path: "/Users", bytes: 3 * GB }] }],
    });
    const v = (await getTestDb().select().from(storageVolumes))[0];
    const d = await c.storage.dirs({ volumeId: v.id });
    expect(d.volume.itemName).toBe("Internal SSD");
    expect(d.dirs.map((x) => [x.path, x.bytes])).toEqual([
      ["/Users", 3 * GB],
      ["/Applications", 1 * GB],
    ]);
    await expect(c.storage.dirs({ volumeId: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run api/test/storage.test.ts`
Expected: FAIL (`overview`/`dirs` missing).

- [ ] **Step 3: `overviewFor` in the library**

Append to `api/lib/storage.ts`:

```typescript
import { rooms } from "@db/schema"; // move to the top import line of the file

const COMPUTER_ROLES = new Set(["laptop", "desktop", "server", "sbc"]);

type DeviceRow = { id: number; name: string; parentId: number | null; roomId: number | null; attributes: Record<string, string | number> | null };

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One device with its volumes; without volumes the block comes from the lab keys (GB → bytes, decimal). */
function deviceOf(row: DeviceRow, volumes: Awaited<ReturnType<typeof volumesForItems>>, roomName: string | null) {
  const mine = volumes.filter((v) => v.itemId === row.id);
  const measured = mine.length > 0;
  const gb = num(row.attributes?.storage_gb);
  const freeGb = num(row.attributes?.storage_free_gb);
  const capacityBytes = measured ? mine.reduce((s, v) => s + v.capacityBytes, 0) : gb != null ? gb * 1e9 : null;
  const usedBytes = measured ? mine.reduce((s, v) => s + v.usedBytes, 0) : gb != null && freeGb != null ? (gb - freeGb) * 1e9 : null;
  return {
    id: row.id,
    name: row.name,
    kind: String(row.attributes?.role ?? "storage"),
    driveType: row.attributes?.drive_type != null ? String(row.attributes.drive_type) : null,
    parentId: row.parentId,
    roomName,
    capacityBytes,
    usedBytes,
    measured,
    volumes: mine.map(({ itemId: _i, source: _s, createdAt: _c, ...v }) => v),
  };
}

export async function overviewFor(db: DbLike, houseId: number | null) {
  const where = houseId != null ? and(eq(items.status, "active"), eq(items.houseId, houseId)) : eq(items.status, "active");
  const all = await db
    .select({ id: items.id, name: items.name, parentId: items.parentId, roomId: items.roomId, attributes: items.attributes, roomName: rooms.name })
    .from(items)
    .leftJoin(rooms, eq(rooms.id, items.roomId))
    .where(where)
    .orderBy(items.name);
  const devices = all.filter((r) => isStorageDevice(r));
  const volumes = await volumesForItems(db, devices.map((d) => d.id));
  const computers = devices.filter((d) => COMPUTER_ROLES.has(String(d.attributes?.role)));
  const computerIds = new Set(computers.map((c) => c.id));
  const internal = devices.filter((d) => d.parentId != null && computerIds.has(d.parentId));
  const externals = devices.filter((d) => !computerIds.has(d.id) && !(d.parentId != null && computerIds.has(d.parentId)));
  const totals = await roleTotals(db);
  return {
    computers: computers.map((c) => ({
      ...deviceOf(c, volumes, c.roomName),
      drives: internal.filter((d) => d.parentId === c.id).map((d) => deviceOf(d, volumes, d.roomName)),
    })),
    externals: externals.map((d) => deviceOf(d, volumes, d.roomName)),
    totals,
    unassignedVolumes: totals.find((t) => t.dataRole === null)?.volumes ?? 0,
  };
}
```

Note: `roleTotals` is unscoped by house on purpose (Review Focus 4: the totals are the inventory's, and a volume counts once). The page says so under the bar.

- [ ] **Step 4: `overview` and `dirs` in the router**

Add to `storageRouter` (imports: `overviewFor` from `../lib/storage`, `desc` from `drizzle-orm`, `items, storageDirs` from `@db/schema`):

```typescript
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run api/test/storage.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Gates and commit**

```bash
cd /Volumes/T7/declutter-storage && npm run check && npx eslint api src scripts 2>&1 | tail -1 && npm test 2>&1 | grep -E "Tests " && git add api && git commit -m "storage.overview and storage.dirs: the block tree, role totals and a volume's biggest directories

Computers carry their internal drives, everything else is external; a
device without a measurement still gets a block from storage_gb and
storage_free_gb, marked unmeasured. Totals per data role sum every
volume once across houses; the overview itself follows the session
house unless houseId: null is passed."
```

---

### Task 4: A collector for the machine it runs on

**Files:**
- Create: `scripts/storage-report-local.mjs`
- Modify: `AGENTS.md` §2 (collector contract), `README.md` (one line under scripts)

**Interfaces:**
- Consumes: `storage.report` (Task 2) over HTTP: `POST <base>/api/trpc/storage.report` with body `{"json": ReportInput}`, header `authorization: Bearer <APP_TOKEN>` when set.
- Produces: `node scripts/storage-report-local.mjs --item <id> [--base http://localhost:3001] [--dirs 15] [--dry]`; the AGENTS.md line the Data Tracker follows.

- [ ] **Step 1: The script**

Create `scripts/storage-report-local.mjs`:

```javascript
#!/usr/bin/env node
// Measure this machine's mounted volumes (df) and the biggest top-level
// directories of each (du), and post one storage.report for one device item.
//   node scripts/storage-report-local.mjs --item 205            # this Mac is item 205
//   node scripts/storage-report-local.mjs --item 205 --dry      # print the report, post nothing
//   --base http://localhost:3001 (default)   --dirs 15 (top directories per volume)
//   --only /,/Volumes/T7                      (mount points to include; default: all local disks)
// Reads APP_TOKEN from .env when the server has one. macOS and Linux (df -k, du -xsk).
import "dotenv/config";
import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import path from "path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((p) => p.length));
const itemId = Number(args.item);
if (!Number.isInteger(itemId)) { console.error("usage: --item <device item id> [--base url] [--dirs n] [--only a,b] [--dry]"); process.exit(2); }
const base = (args.base || "http://localhost:3001").replace(/\/$/, "");
const topN = Number(args.dirs || 15);
const only = args.only ? String(args.only).split(",") : null;

// df -k: Filesystem 1024-blocks Used Available Capacity [iused ifree %iused] Mounted on
const lines = execFileSync("df", ["-kP"], { encoding: "utf8" }).trim().split("\n").slice(1);
const volumes = [];
for (const line of lines) {
  const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
  if (!m) continue;
  const [, device, blocks, used, , mountPoint] = m;
  const local = device.startsWith("/dev/") && !/^\/(System|private\/var\/vm|dev)/.test(mountPoint) && !mountPoint.startsWith("/System/Volumes");
  if (!local && !only) continue;
  if (only && !only.includes(mountPoint)) continue;
  volumes.push({ device: device.replace(/^\/dev\//, ""), mountPoint, capacityBytes: Number(blocks) * 1024, usedBytes: Number(used) * 1024 });
}
if (volumes.length === 0) { console.error("no local volumes found (use --only to name mount points)"); process.exit(1); }

function topDirs(mountPoint) {
  let names;
  try { names = readdirSync(mountPoint); } catch { return []; }
  const sizes = [];
  for (const name of names) {
    const p = path.join(mountPoint, name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    if (name.startsWith(".") && name !== ".Trashes") continue;
    try {
      const out = execFileSync("du", ["-xsk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const kb = Number(out.split("\t")[0]);
      if (Number.isFinite(kb)) sizes.push({ path: p, bytes: kb * 1024 });
    } catch { /* unreadable: skip */ }
  }
  return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, topN);
}

for (const v of volumes) {
  process.stderr.write(`measuring ${v.mountPoint} …\n`);
  v.dirs = topDirs(v.mountPoint);
  v.label = path.basename(v.mountPoint) || null;
}
const report = { itemId, source: "local-script", volumes };
if (args.dry) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const headers = { "content-type": "application/json", ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}) };
const res = await fetch(`${base}/api/trpc/storage.report`, { method: "POST", headers, body: JSON.stringify({ json: report }) });
const body = await res.json();
if (!res.ok) { console.error(`storage.report failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
console.log(`reported ${body.result.data.json.volumes} volume(s), ${body.result.data.json.dirs} directories for item ${itemId} to ${base}`);
```

- [ ] **Step 2: Dry run on this Mac**

Run: `cd /Volumes/T7/declutter-storage && node scripts/storage-report-local.mjs --item 205 --dry --dirs 5 --only /,/Volumes/T7 | head -40`
Expected: a JSON report with two volumes, each with up to five `dirs`, `usedBytes` below `capacityBytes`. (`du` over `/` can take a minute; `--only` and `--dirs 5` keep the dry run short. Item 205 is "MacBook Air M2" on live; check with `curl -s 'http://localhost:3001/api/trpc/items.get?input=%7B%22json%22%3A%7B%22id%22%3A205%7D%7D' | head -c 200` that it is this machine before any live post. If it is not, find this Mac's item by name (`hostname`), or stop and ask.)

- [ ] **Step 3: Real post against a dev server on the test database**

```bash
cd /Volumes/T7/declutter-storage && node scripts/seed-test-db.mjs | tee ~/storage-seed.json
cd /Volumes/T7/declutter-storage && TEST_URL="$(node -e 'require("dotenv").config({ quiet: true }); process.stdout.write(process.env.TEST_DATABASE_URL)')" && DATABASE_URL="$TEST_URL" npx vite --port 3002
```

(second command in the background; wait for `Local: http://localhost:3002/`), then:

```bash
cd /Volumes/T7/declutter-storage && LAPTOP=$(node -e 'console.log(require(process.env.HOME+"/storage-seed.json").items.laptop)') && node scripts/storage-report-local.mjs --item $LAPTOP --base http://localhost:3002 --dirs 5 --only /,/Volumes/T7 && curl -s "http://localhost:3002/api/trpc/storage.overview?input=%7B%22json%22%3A%7B%22houseId%22%3Anull%7D%7D" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).result.data.json;for(const c of o.computers)console.log(c.name,c.measured,c.volumes.map(v=>v.mountPoint+" "+Math.round(v.usedBytes/1e9)+"/"+Math.round(v.capacityBytes/1e9)+"GB dirs="+v.dirCount).join(" | "))})'
```

Expected: `reported 2 volume(s), N directories …` and the overview line shows the seeded ThinkPad X220 as measured with `/` and `/Volumes/T7`. Leave the dev server running for Task 5 if the same session continues; otherwise stop it (`kill $(lsof -nP -iTCP:3002 -sTCP:LISTEN -t)`).

- [ ] **Step 4: Contract in AGENTS.md and a README line**

In `AGENTS.md` §2, after the "Data Tracker sync" bullet, add:

```markdown
- Storage collectors (`scripts/storage-report-local.mjs` for the machine it runs on; the Data Tracker for the others): tRPC `storage.report({ itemId, source, volumes: [{ mountPoint, label?, fsType?, device?, capacityBytes, usedBytes, dirs?: [{ path, bytes }] }] })`, bytes, at most 64 volumes and 100 directories per volume, only for an item whose `role` is `laptop`, `desktop`, `server`, `sbc`, `nas` or `storage`. A report never changes a volume's `dataRole` and never deletes a volume; it keeps the device's `storage_gb`/`storage_free_gb` equal to the sum of its volumes. Reads: `storage.overview`, `storage.dirs`; the role is set with `storage.setRole({ volumeId, dataRole })`, one of `unique`, `test`, `backup`, `archive`, `system`, `media`, `scratch` or `null`.
```

In `README.md`, under the scripts or "Notes for self-hosting" section, add one line: `` `node scripts/storage-report-local.mjs --item <id>` measures this machine's volumes and top directories and posts them to the Storage page (`/storage`). ``

- [ ] **Step 5: Gates and commit**

```bash
cd /Volumes/T7/declutter-storage && npx eslint scripts 2>&1 | tail -1 && git add scripts/storage-report-local.mjs AGENTS.md README.md && git commit -m "A local storage collector and the collector contract

scripts/storage-report-local.mjs measures the machine it runs on (df for
volumes, du for the biggest top-level directories) and posts one
storage.report; AGENTS.md records the contract the Data Tracker follows
for the other machines."
```

---

### Task 5: The Storage page

**Files:**
- Create: `src/components/storage/Blocks.tsx`, `src/pages/Storage.tsx`
- Modify: `src/App.tsx` (route), `src/components/Layout.tsx` (nav)

**Interfaces:**
- Consumes: `storage.overview`, `storage.dirs`, `storage.setRole` (Tasks 2–3); `useHouse()` from `@/context/house`; `trpc` from `@/providers/trpc`; icons from `lucide-react`.
- Produces: route `/storage`; `formatBytes(n: number | null): string`.

- [ ] **Step 1: Presentational blocks**

Create `src/components/storage/Blocks.tsx`:

```tsx
import { cn } from "@/lib/utils";

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

export const ROLE_COLORS: Record<string, string> = {
  unique: "#b91c1c",
  test: "#a16207",
  backup: "#15803d",
  archive: "#1d4ed8",
  system: "#6b7280",
  media: "#7e22ce",
  scratch: "#c2410c",
};

export type VolumeLike = {
  id: number;
  mountPoint: string;
  label: string | null;
  capacityBytes: number;
  usedBytes: number;
  dataRole: string | null;
  measuredAt: Date | string;
};

export type DeviceLike = {
  id: number;
  name: string;
  kind: string;
  driveType: string | null;
  capacityBytes: number | null;
  usedBytes: number | null;
  measured: boolean;
  volumes: VolumeLike[];
};

/** Block width follows capacity on a shared scale; the fill is use. Volumes split the block. */
export function DeviceBlock({
  device,
  maxBytes,
  selectedVolumeId,
  onSelectVolume,
}: {
  device: DeviceLike;
  maxBytes: number;
  selectedVolumeId: number | null;
  onSelectVolume: (volumeId: number) => void;
}) {
  const cap = device.capacityBytes ?? 0;
  const widthPct = maxBytes > 0 ? Math.max(8, (cap / maxBytes) * 100) : 100;
  const unmeasured = !device.measured;
  return (
    <div className="flex flex-col gap-1" style={{ width: `${widthPct}%`, minWidth: 96 }}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate font-medium">{device.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {device.driveType ? `${device.driveType} · ` : ""}
          {formatBytes(device.capacityBytes)}
        </span>
      </div>
      <div
        className={cn("flex h-12 w-full overflow-hidden rounded-md border", unmeasured ? "border-dashed border-border bg-[repeating-linear-gradient(135deg,#f3f4f6_0_6px,#ffffff_6px_12px)]" : "border-border bg-muted")}
        title={unmeasured ? "No measurement yet: block from storage_gb / storage_free_gb" : undefined}
      >
        {unmeasured ? (
          <div className="h-full bg-muted-foreground/30" style={{ width: cap > 0 && device.usedBytes != null ? `${(device.usedBytes / cap) * 100}%` : "0%" }} />
        ) : (
          device.volumes.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectVolume(v.id)}
              className={cn("relative h-full border-r border-white/70 last:border-r-0 text-left outline-none", selectedVolumeId === v.id && "ring-2 ring-inset ring-black")}
              style={{ width: `${cap > 0 ? (v.capacityBytes / cap) * 100 : 100}%` }}
              title={`${v.label ?? v.mountPoint} · ${formatBytes(v.usedBytes)} of ${formatBytes(v.capacityBytes)}${v.dataRole ? ` · ${v.dataRole}` : " · no data role"}`}
            >
              <div className="absolute inset-y-0 left-0" style={{ width: `${v.capacityBytes > 0 ? (v.usedBytes / v.capacityBytes) * 100 : 0}%`, background: v.dataRole ? ROLE_COLORS[v.dataRole] : "#9ca3af" }} />
              <span className="absolute inset-x-1 bottom-0.5 truncate text-[10px] leading-none text-black/80 mix-blend-multiply">{v.label ?? v.mountPoint}</span>
            </button>
          ))
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {device.usedBytes != null && device.capacityBytes ? `${Math.round((device.usedBytes / device.capacityBytes) * 100)}% used` : "no use data"}
        {unmeasured && " · unmeasured"}
      </div>
    </div>
  );
}
```

Check `cn` exists at `@/lib/utils` (the Workbench uses it elsewhere: `grep -rn "from \"@/lib/utils\"" src/pages | head -1`); if the helper lives elsewhere, import from there.

- [ ] **Step 2: The page**

Create `src/pages/Storage.tsx`:

```tsx
import { useMemo, useState } from "react";
import { HardDrive, Server, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { DeviceBlock, ROLE_COLORS, formatBytes } from "@/components/storage/Blocks";

const ROLES = ["unique", "test", "backup", "archive", "system", "media", "scratch"] as const;
type Role = (typeof ROLES)[number];

/** Every computer with its drives and volumes as blocks; click a volume for its biggest directories and its data role. */
export default function StoragePage() {
  const { houseId, houses } = useHouse();
  const [allHouses, setAllHouses] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const overview = trpc.storage.overview.useQuery({ houseId: allHouses ? null : houseId });
  const dirs = trpc.storage.dirs.useQuery({ volumeId: selected ?? 0 }, { enabled: selected != null });
  const setRole = trpc.storage.setRole.useMutation({
    onSuccess: () => {
      utils.storage.overview.invalidate();
      utils.storage.dirs.invalidate();
    },
  });

  const o = overview.data;
  const maxBytes = useMemo(() => {
    if (!o) return 0;
    const all = [...o.computers.flatMap((c) => [c, ...c.drives]), ...o.externals];
    return Math.max(0, ...all.map((d) => d.capacityBytes ?? 0));
  }, [o]);
  const totalCapacity = o?.totals.reduce((s, t) => s + t.capacityBytes, 0) ?? 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Computers with their disks and volumes as blocks: width is capacity, fill is use, colour is the data role. Click a volume for its biggest directories.
          </p>
        </div>
        {houses.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allHouses} onChange={(e) => setAllHouses(e.target.checked)} /> All houses
          </label>
        )}
      </div>

      {o && (
        <section className="mt-6 rounded-lg border border-border bg-white p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">By data role</h2>
            <span className="text-[12px] text-muted-foreground">
              {formatBytes(o.totals.reduce((s, t) => s + t.usedBytes, 0))} used of {formatBytes(totalCapacity)} measured, every house
              {o.unassignedVolumes > 0 && ` · ${o.unassignedVolumes} volume(s) without a role`}
            </span>
          </div>
          <div className="mt-2 flex h-6 w-full overflow-hidden rounded border border-border">
            {o.totals.length === 0 && <div className="w-full bg-muted" />}
            {o.totals.map((t) => (
              <div
                key={t.dataRole ?? "none"}
                title={`${t.dataRole ?? "no role"}: ${formatBytes(t.usedBytes)} used of ${formatBytes(t.capacityBytes)} in ${t.volumes} volume(s)`}
                style={{ width: `${totalCapacity > 0 ? (t.capacityBytes / totalCapacity) * 100 : 0}%`, background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }}
                className="relative border-r border-white/70 last:border-r-0"
              >
                <div className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${t.capacityBytes > 0 ? (t.usedBytes / t.capacityBytes) * 100 : 0}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {o.totals.map((t) => (
              <span key={t.dataRole ?? "none"} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }} />
                {t.dataRole ?? "no role"} · {formatBytes(t.usedBytes)} / {formatBytes(t.capacityBytes)}
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {overview.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {o?.computers.length === 0 && o.externals.length === 0 && <p className="text-sm text-muted-foreground">No computers, drives or NAS boxes in this house.</p>}
          {o?.computers.map((c) => (
            <section key={c.id} className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{c.name}</h2>
                <span className="text-[12px] text-muted-foreground">{c.kind}{c.roomName ? ` · ${c.roomName}` : ""}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {c.drives.length === 0 || c.volumes.length > 0 ? <DeviceBlock device={c} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} /> : null}
                {c.drives.map((d) => (
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} />
                ))}
              </div>
            </section>
          ))}
          {o && o.externals.length > 0 && (
            <section className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">External drives and NAS</h2>
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {o.externals.map((d) => (
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="lg:sticky lg:top-4 h-fit rounded-lg border border-border bg-white p-4">
          {selected == null && <p className="text-sm text-muted-foreground">Select a volume to see its biggest directories and set its data role.</p>}
          {selected != null && dirs.data && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{dirs.data.volume.label ?? dirs.data.volume.mountPoint}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {dirs.data.volume.itemName} · {dirs.data.volume.mountPoint} · {formatBytes(dirs.data.volume.usedBytes)} of {formatBytes(dirs.data.volume.capacityBytes)} · measured {new Date(dirs.data.volume.measuredAt).toLocaleString()}
                  </div>
                </div>
                <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="rounded p-1 hover:bg-accent/40"><X className="h-4 w-4" /></button>
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Data role</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={setRole.isPending}
                      onClick={() => setRole.mutate({ volumeId: selected, dataRole: dirs.data!.volume.dataRole === r ? null : (r as Role) })}
                      className="rounded-full border px-2.5 py-1 text-[12px] disabled:opacity-50"
                      style={dirs.data.volume.dataRole === r ? { background: ROLE_COLORS[r], color: "white", borderColor: ROLE_COLORS[r] } : { borderColor: "var(--border, #e5e7eb)" }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Biggest directories</div>
                {dirs.data.dirs.length === 0 && <p className="mt-1 text-[12px] text-muted-foreground">No directory measurement for this volume yet.</p>}
                <ul className="mt-1 space-y-1">
                  {dirs.data.dirs.map((d) => (
                    <li key={d.path} className="text-[12px]">
                      <div className="flex justify-between gap-2"><span className="truncate" title={d.path}>{d.path}</span><span className="shrink-0 tabular-nums">{formatBytes(d.bytes)}</span></div>
                      <div className="h-1.5 w-full rounded bg-muted"><div className="h-full rounded bg-foreground/60" style={{ width: `${dirs.data!.volume.usedBytes > 0 ? Math.min(100, (d.bytes / dirs.data!.volume.usedBytes) * 100) : 0}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Route and nav**

In `src/App.tsx`: add `const StoragePage = lazy(() => import("@/pages/Storage"));` next to the other lazy pages and `<Route path="/storage" element={<StoragePage />} />` after the `/galaxy` route. In `src/components/Layout.tsx` `NAV`, after the Galaxy entry: `{ to: "/storage", label: "Storage", icon: HardDrive },` and add `HardDrive` to the `lucide-react` import.

- [ ] **Step 4: Gates**

Run: `cd /Volumes/T7/declutter-storage && npm run check && npx eslint api src scripts 2>&1 | tail -1 && npm run build 2>&1 | tail -1`
Expected: clean; eslint not above 31.

- [ ] **Step 5: Click-through (controller, Chrome, dev server on the test database)**

With the Task 4 dev server on :3002 and its report posted (re-run Task 4 Step 3 if the suite ran since, because `npm test` truncates the test database), open `http://localhost:3002/storage` with console capture on.

1. The "By data role" bar shows one grey segment ("no role") and "2 volume(s) without a role".
2. Under "ThinkPad X220" there are blocks: the laptop's own measured block (two volumes `/` and `T7` as segments, grey fills) and the "ThinkPad SSD" drive block hatched, labelled "unmeasured".
3. Click the `/` segment: the side panel names the volume, the device, used/capacity, the measurement time, and lists up to five directories biggest first with bars.
4. Click the role "unique": the chip turns red, the segment fill turns red, the totals bar gains a red segment and the "without a role" count drops to 1. Click "unique" again: it clears.
5. Tick "All houses": the Zomerhuis Pan is not a device, so the list is unchanged; untick.
6. Console: no errors; network: no 4xx/5xx.

Stop the dev server afterwards.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/T7/declutter-storage && git add src && git commit -m "Storage page: computers, drives and volumes as blocks, directories on click, one-click data role

Width is capacity on a shared scale, fill is use, colour is the data
role; unmeasured devices draw a hatched block from their lab keys. The
side panel lists a volume's biggest directories and sets its role; the
bar on top rolls capacity and use up per role across every house."
```

---

### Task 6: Land it and measure this Mac

**Files:** none in the code. Notes in `~/storage-notes.md`.

- [ ] **Step 1: Final whole-branch review**

Dispatch the final reviewer (superpowers requesting-code-review template, most capable model) on `main..storage-overview`; fix round if needed.

- [ ] **Step 2: Merge and report**

```bash
cd /Volumes/T7/declutter && git merge --ff-only storage-overview && git log --oneline -6 && git worktree remove /Volumes/T7/declutter-storage && git branch -d storage-overview
```

Tell Rick: migration 0007 is on live already (Task 1), the page is on `main`, the restart one-liner puts it on :3001, and after the restart `node scripts/storage-report-local.mjs --item <this Mac's item id>` fills the first real blocks. Push is his.

- [ ] **Step 3: After Rick's restart: first real report**

```bash
cd /Volumes/T7/declutter && node scripts/storage-report-local.mjs --item <id> --dirs 15 && node -e 'fetch("http://localhost:3001/api/trpc/storage.overview?input=%7B%22json%22%3A%7B%22houseId%22%3Anull%7D%7D").then(r=>r.json()).then(j=>{const o=j.result.data.json;console.log("measured devices:",[...o.computers.flatMap(c=>[c,...c.drives]),...o.externals].filter(d=>d.measured).map(d=>d.name))})'
```

Then tell the declutter-flow session the contract line (AGENTS.md §2) so the Data Tracker can post reports for prodesk-rt1, the NAS and the others.

---

## Self-review

**Spec coverage.** Blocks per computer with disks and volumes, internal vs external: Task 3 (grouping) + Task 5 (blocks). Capacity, use, free: `storage_volumes` bytes (Task 1–2), attribute fallback (Task 3), `formatBytes` (Task 5). Click → biggest top dirs: `storage_dirs`, `storage.dirs` (Tasks 1–3), side panel (Task 5). Quick role assignment: `storage.setRole` (Task 2), chips (Task 5). Roll-up per category: `roleTotals` (Task 2–3), bar (Task 5). What we capture today: the collector (Task 4) and the tracker contract (Task 4, 6).

**Placeholders.** None: every code step carries its code; Task 6 Step 3's `<id>` is this Mac's item id, found in Task 4 Step 2.

**Type consistency.** `ReportInput`/`reportVolume` match between lib, router, test and script (`dirs` optional, bytes integers). `volumesForItems` returns rows with `dirCount`; `deviceOf` strips `itemId/source/createdAt` for the `Volume` shape the page reads (`id, mountPoint, label, fsType, device, capacityBytes, usedBytes, dataRole, measuredAt, dirCount`). `storage.dirs` returns the full row plus `itemName`, which the page reads for `label`, `mountPoint`, `usedBytes`, `capacityBytes`, `measuredAt`, `dataRole`, `itemName`. `ROLES` in the page equals `DATA_ROLES`.

**Review Focus.** 1 → Task 2 test 1 (kept volume). 2 → Task 2 test 3. 3 → Task 2 test 2. 4 → Task 3 test 2. 5 → Task 3 test 1.

## Data Tracker fit (read 2026-10-04 from 10.50.0.142/data-tracker-architecture.html)

The tracker (server.js on prodesk-rt1 :3477, `data-sources.json`, upsert-by-name) already holds per-mount `df` rows for prodesk-rt1 and docker-host (`host:mountpoint`, size/used/available, device, fstype; tmpfs and < 100 MB filtered) from `disk_scanner.sh`, and whole-disk capacity plus model/CPU/RAM from the push reporters on the Macs, Pi's and the Synology. It collects no top-level directory sizes (only `du -sb` on Docker volumes). So:

- Its existing `homebase-sync.js` (which already maps tracker hosts to HomeBase item ids in `homebase-map.json`) is the right place to post `storage.report`: one report per mapped device, `volumes` from the `host:mountpoint` sources of that host, `source: "data-tracker"`, `dirs` omitted. That gives capacity and use for every machine it sees without new collectors.
- Top directories for those machines are a later tracker addition (a `du -xsk <mount>/*` step in `disk_scanner.sh`); the contract already accepts them.
- This plan's `scripts/storage-report-local.mjs` covers the Macs the tracker only sees whole-disk, and is the reference for the payload.
- The two systems stay complementary: the tracker is the registry of data sources, backups and protection; HomeBase holds the physical device and its volumes' data role. Nothing in this plan duplicates the tracker's protection matrix.
