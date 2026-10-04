# Storage Volumes per Container and Attached Drives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every APFS volume its own row and its own data role while its block keeps the container's capacity (so "T7" and "TM-T7" can be archive and backup on one disk), make the role roll-up count used bytes per role plus free space, and let an external drive hang under the computer it is attached to.

**Architecture:** `storage_volumes` gains a nullable `container` column; volumes sharing a container share its capacity and free space, so the overview sums capacity once per container and used per volume, and the device keys `storage_gb`/`storage_free_gb` follow the same rule. Totals become `usedBytes` per data role plus one `freeBytes` figure. An `attached-to` relation (drive → computer) groups an external device under its host in the overview without making it internal; the page's panel sets or clears it with the existing `items.addRelation`/`items.removeRelation`.

**Tech Stack:** as the 2026-10-04 storage plan: Drizzle/MySQL, tRPC 11, React 19, vitest seam, Node collector.

**Spec:** Rick, 2026-10-04: "1 drive had often multiple roles" and "The mac mini does not show T7 and NVMe?"; answer agreed: option 1 (separate volumes with one role each, shared container capacity) plus an attached-to link.

## Global Constraints

- AGENTS.md §2–§4 as before: contracts stay callable; migration additive only (one nullable column), applied to test then live; worktree `/Volumes/T7/declutter-storage2`, branch `storage-volumes`; one commit per task; no new deps; tests on the seam only; baselines now 121 tests, eslint 31; production restart is Rick's.
- `storage.report` keeps accepting the old payload (no `container` field) unchanged: a volume without a container is its own container.
- Totals: `usedBytes` per role is exact; capacity is never attributed to a role (free space belongs to no role).

## Review Focus

1. Two volumes in one container reported in two separate reports (the Data Tracker sends one host per report, but a human may run `--only` twice): the device capacity must still count the container once. Test in Task 2.
2. A volume that moves container (same mount point, different `container` in a later report): the row updates, no duplicate. Test in Task 2.
3. `attached-to` with the computer archived or in another house: the drive falls back to externals (as internal drives do today), never disappears. Test in Task 3.
4. Removing the attached-to relation from the panel while the overview is open: the block moves back to externals on refetch, no stale selection crash. Click-through in Task 4.
5. Container capacity when one of its volumes is removed with `storage.removeVolume`: capacity stays (the container still exists) as long as one volume remains. Test in Task 2.

---

### Task 1: `container` column

**Files:** `db/schema.ts` (add `container: varchar("container", { length: 64 })` after `device` in `storageVolumes`, with a comment: "volumes sharing a container share its capacity (APFS); null = its own container"), migration `0008_storage_container.sql` (generated; expect one `ALTER TABLE storage_volumes ADD container varchar(64)`), `api/test/storage.test.ts` (extend the tables test to expect `container`).

Steps: worktree from main (`git worktree add /Volumes/T7/declutter-storage2 -b storage-volumes main`, `npm install`, copy `.env`); failing test; schema; `npm run db:generate -- --name storage_container`; read the SQL (one ALTER, nothing else, else BLOCKED); apply to test (`DATABASE_URL="$TEST_URL" npm run db:migrate`) then live (`npm run db:migrate`); gates; commit "storage_volumes.container: volumes that share an APFS container share its capacity".

### Task 2: Container-aware report, overview and totals

**Files:** `api/lib/storage.ts`, `api/routers/storage.ts`, `api/test/storage.test.ts`.

**Interfaces produced:**
- `storage.report` volume input gains `container?: string | null` (≤64). Stored on the row; updated on every report.
- `deviceCapacity(volumes)`: sum of `capacityBytes` once per distinct container key (`container ?? "vol:" + id`); `deviceUsed(volumes)`: sum of `usedBytes`. Used by `applyReport` (device keys: `storage_gb = round(capacity/1e9)`, `storage_free_gb = round((capacity − used)/1e9)`), by `removeVolume`'s recompute, and by `deviceOf` (`capacityBytes`, `usedBytes`, `freeBytes`).
- Overview volume shape gains `container: string | null` and `shareOfContainer: number` (this volume's used ÷ container capacity, for the segment width).
- `roleTotals` → `{ dataRole, volumes, usedBytes }[]` (no capacity) and the overview gains `freeBytes` (sum over active devices' containers of capacity − used) and `capacityBytes` (sum of container capacities). `unassignedVolumes` unchanged.
- Validation: within one report, volumes with the same `container` must carry the same `capacityBytes` (else BAD_REQUEST "container X: capacity differs between volumes"); the sum of `usedBytes` of a container's volumes (across the stored rows after upsert) must not exceed its capacity (else BAD_REQUEST).

Tests (append; seam): (a) two volumes same container in one report → device `storage_gb` = one capacity, `storage_free_gb` = capacity − sum used, overview device capacity once, `freeBytes` right; (b) same two volumes in two separate reports → same result (Review Focus 1); (c) a volume re-reported with a different `container` updates in place (Review Focus 2); (d) `removeVolume` of one of two → capacity unchanged, used drops (Review Focus 5); (e) roles: set backup on one, archive on the other → totals used per role exact, `freeBytes` unchanged; (f) container capacity mismatch rejected. Update existing tests for the new totals shape (`capacityBytes` gone from totals).

Commit: "Volumes share their container's capacity; totals count used bytes per role plus free".

### Task 3: Attached-to in the overview

**Files:** `api/lib/storage.ts` (`overviewFor`), `api/test/storage.test.ts`, `AGENTS.md` §2.

- Relation type `attached-to`: `fromItemId` = the drive/NAS item, `toItemId` = the computer. Written with the existing `items.addRelation({ fromItemId, toItemId, type: "attached-to" })`, removed with `items.removeRelation({ id })`.
- `overviewFor`: read `relations` where `type = 'attached-to'`; a device (not a computer, not internal) whose relation points at a computer in the result set goes into that computer's new `attached: Device[]` (each with `attachedRelationId: number`) and leaves `externals`. Otherwise it stays external (Review Focus 3). Also read `backs-up` relations: every device gains `backsUp: Array<{ relationId, itemId, name }>` (devices it holds backups of) so the page can badge a Time Machine disk.
- AGENTS.md §2 "Data meaning": add `- A relation of type \`attached-to\` means \`fromItemId\` (an external drive or NAS) is plugged into or mounted on \`toItemId\` (a computer); the Storage page groups it under that computer. It does not make the drive internal.` and extend the storage-collectors bullet with the `container` field and the capacity rule.

Tests: attached drive appears under its computer with `attachedRelationId`, not in externals; same drive with the computer archived → externals; `backsUp` lists the right names.

Commit: "Storage overview: external drives hang under the computer they are attached to".

### Task 4: Page and collector

**Files:** `src/pages/Storage.tsx`, `src/components/storage/Blocks.tsx`, `scripts/storage-report-local.mjs`, `README.md`.

Page:
- Totals bar: segments = used per role (role colours) + one light "free" segment; legend lists roles with used GB and "free · N GB"; header "X used of Y, every house · N volume(s) without a role".
- Device block: width by container capacity (unchanged); segments = volumes, each sized by `shareOfContainer`, followed by a free remainder segment (no border, light); a volume's fill is solid role colour; label = volume label. Two volumes in one container therefore draw as two coloured segments inside one block.
- Under each computer: its drives row as today, then an "attached" row (same `DeviceBlock`, a small "attached" tag; a "backs up <name>" badge when `backsUp` is non-empty).
- Panel: an "Attached to" select listing the house's computers (from `overview.computers`) plus "— none —"; choosing one calls `items.addRelation({ fromItemId: device.id, toItemId, type: "attached-to" })` (after removing an existing `attachedRelationId`), "none" calls `items.removeRelation`; both invalidate `storage.overview`. Only shown for devices that are not computers and not internal.

Collector: report one volume per APFS volume again: `mountPoint` per volume, `usedBytes` = that volume's `Used` column × 1024, `capacityBytes` = container blocks × 1024, `container` = `diskN`, `device` = `diskNsM`, label = the volume name; Linux: `container` null, `usedBytes` = blocks − available. Default scope stays the boot container (all its volumes except `/System/Volumes/*`, i.e. `/` only on a normal Mac); `--only /Volumes/T7` reports every volume of T7's container (T7 and TM-T7 as two volumes). `/` keeps measuring directories on `/System/Volumes/Data`. README example updated.

Click-through (controller, dev server on the test DB with a `--only /Volumes/T7` report against the seeded laptop and a `/` report against the seeded SSD): the laptop block shows two coloured segments (T7, TM-T7) plus free; give TM-T7 "backup" and T7 "archive": the totals bar shows both colours and free; the SSD block shows "/" plus free; set the SSD attached to the X220 from the panel: it moves under the computer with the "attached" tag; set none: it moves back; no console errors.

Commit: "Storage page: volumes as segments in one container block, attached drives under their computer; collector reports APFS volumes separately".

### Task 5: Land, deploy, re-report

Final review (opus), one fix round, merge, worktree removal. Rick restarts :3001. Then: `node scripts/storage-report-local.mjs --item 51` and `--item 243 --only /Volumes/T7`; set T7 attached to the Mac mini via the panel or `items.addRelation`; tell declutter-flow about the `container` field (one line per host; the tracker may leave it null) and the `attached-to` relation.
