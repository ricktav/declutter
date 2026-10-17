# Rescan Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A second GeoJSON import of the same room is a new, timestamped version of that room: existing Things are matched to the new polygons and moved, new polygons become new Things, Things that are no longer detected are flagged, and nothing is duplicated.

**Architecture (updated 2026-10-05, Rick: "rescan is not a brute replace, it should be possible to compare old and new, and if possible it should be able to revert/undo"):** every scan import writes a `room_scans` row with the room's geometry before and after and the list of Thing changes it made, so the Workbench can show the difference between two versions and the latest scan of a room can be reverted. One pure matcher in `api/lib/scanMerge.ts` (`matchScanItems`) decides which existing Thing each polygon is, by the polygon kind stored on the Thing at creation (`scan_kind`) and the distance between footprint centres. `inbox.importGeojson` uses it inside its transaction: update matched Things' `pos`, insert the rest, flag the missing ones with `scan.missing_at`, refresh the room's walls and `scanDate`, log one room event with the counts. A capture that was already imported is refused.

**Tech Stack:** tRPC 11, Drizzle/MySQL, vitest seam (`api/test/`), no schema change.

**Spec:** Rick, 2026-10-05: "There won't be a need for a second scan unless the situation changed (different placing/move), then we should be able to upload another timestamped version of the new situation of the same room. Existing items should be fairly easy to match and new items are just that." Earlier review finding: `inbox.importGeojson` inserts one new item per polygon on every import, so a re-import duplicates the set.

## Global Constraints

- AGENTS.md §2: `inbox.*` inputs and outputs unchanged (the output may gain counts). Flow (`src/flow/`) untouched. No schema change, no new dependency.
- Worktree `/Volumes/T7/declutter-rescan`, branch `rescan-merge`, from `main`. Shared test DB: wait until `pgrep -f 'vitest run'` is empty before `npm test`; run only the files you touch while iterating.
- Baselines: 187 tests, eslint 31 problems. Gates before commit: `npm run check`, `npx eslint .` (no new problems), `npm test` of the touched files.
- Attribute keys (add to AGENTS.md §2 "Data meaning"): plain `scan_kind` (the exporter's polygon kind, e.g. `stove`, set on a Thing created from a scan); workflow `scan.missing_at` (`YYYY-MM-DD`, set when the latest scan of its room did not detect the Thing, removed when a later scan does). Dates are `YYYY-MM-DD`.

## Review Focus

1. The same file imported twice: zero new Things, same ids, positions unchanged, room `scanDate` newer. Test in Task 2.
2. A Thing the user renamed and confirmed ("Stove" → "Smeg fornuis", `confirmed`) still matches by `scan_kind`, keeps name and verification, only `pos` changes. Test in Task 2.
3. Two polygons of one kind near each other (two chairs): greedy nearest-first must not assign both to one Thing; each Thing matched at most once. Test in Task 1.
4. A Thing moved by the user on the plan after the first scan, then rescanned at the new place: it matches (distance within tolerance) and is not duplicated; moved further than the tolerance: a new Thing is created and the old one is flagged missing, never silently repositioned across the room. Test in Task 1 (tolerance) and Task 2.
5. Importing a capture that is already `processed`: BAD_REQUEST "already imported", nothing written. Test in Task 2.

---

### Task 1: `matchScanItems`

**Files:** create `api/lib/scanMerge.ts`, `api/test/scanMerge.test.ts` (pure, no DB).

**Interface produced:**
```ts
export type ScanCandidate = { id: number; name: string; scanKind: string | null; pos: { xM: number; yM: number; wM: number; dM: number } | null };
export type ScanPoly = { kind: string; label: string; xM: number; yM: number; wM: number; dM: number }; // bbox of the polygon, metres, room frame
export const MATCH_TOLERANCE_M = 0.75;
export function matchScanItems(existing: ScanCandidate[], polys: ScanPoly[]): {
  matched: Array<{ itemId: number; poly: ScanPoly; movedM: number }>;
  unmatchedPolys: ScanPoly[];
  missingItemIds: number[]; // existing with scanKind != null and pos != null, not matched
}
```
Rules: a candidate needs `pos`; it is eligible for a poly when `scanKind === poly.kind`, or when `scanKind` is null and its name (trailing " <n>" stripped, case-insensitive) equals `poly.label` (Things from before this change). Distance = between footprint centres. Only pairs with distance ≤ `max(MATCH_TOLERANCE_M, 0.5 * max(diagonal(item), diagonal(poly)))` are eligible. Build all eligible pairs, sort by distance, take greedily; each Thing and each poly at most once. `movedM` is that distance. Things without `scanKind` and without a name match are never "missing" (they were placed by hand, not by a scan).

Tests: identical sets → all matched, movedM 0; a shifted poly within tolerance → matched with movedM; shifted beyond tolerance → unmatched poly + missing item; two chairs 0.6 m apart with two chair polys → two distinct matches (Review Focus 3); legacy Thing "Chair 2" with null scanKind matches a `chair` poly; a hand-placed Thing (null scanKind, unrelated name) is never missing.

Commit: "scanMerge: match a rescan's polygons to the room's existing Things".

### Task 2: `inbox.importGeojson` merges instead of duplicating

**Files:** `api/routers/inbox.ts` (the `importGeojson` procedure, item loop around lines 714–760), `api/test/inbox-location.test.ts` (append a describe), `AGENTS.md` §2 Data meaning (two bullets per Global Constraints).

Steps:
1. Before any write: if `cap.status === "processed"` throw `TRPCError({ code: "BAD_REQUEST", message: "This capture was already imported." })`.
2. Build `polys: ScanPoly[]` from `furniturePolys` with the existing bbox code (`xM, yM, wM ≥ 0.1, dM ≥ 0.1`) and `meta.label`.
3. Load the room's active Things (`status = "active"`, `verificationStatus != "rejected"`, `roomId = match.id`) when `match` exists, map to `ScanCandidate` (`scanKind = attributes.scan_kind ?? null`), call `matchScanItems`.
4. Matched: `update items set pos = { ...old pos, xM, yM, wM, dM, hM: meta.hM ?? old.hM }` keeping `rotDeg`; remove `scan.missing_at` from attributes if present; log an item event `moved` with summary "Moved by the <room> rescan (<movedM> m)" only when `movedM > 0.05`.
5. Unmatched polys: insert as today (same naming scheme, continuing the per-label count after the existing Things so names stay unique), plus `attributes: { scan_kind: poly.kind }`.
6. Missing: set `attributes["scan.missing_at"] = today (YYYY-MM-DD)`; do not touch `pos`, room or verification.
7. Room: update as today plus `scanDate: new Date()`. Event summary: `Room "<name>" rescanned: <matched> matched (<moved> moved), <created> new, <missing> missing` (first import keeps the current "created" wording). Return value gains `{ matched, moved, created, missing }` next to whatever it returns today.
8. AGENTS.md: the two attribute bullets; one line in the `inbox.*` contract note that a re-import of a room merges by `scan_kind` and never duplicates.

Tests (seam, using the existing `seed()` helper and a small inline GeoJSON with two furniture polygons; write the file to `uploads/` the way the existing seed writes a capture file, or reuse its helper): first import creates 2 Things with `scan_kind`; second import of the same bytes as a new capture → 0 created, same ids, same pos, `scanDate` advanced (Review Focus 1); rename + confirm one Thing, import a version with that polygon shifted 0.3 m → same id, new pos, name and verification kept (Review Focus 2); import a version missing one polygon → `scan.missing_at` set, pos kept; import the full version again → key removed; a version with a polygon 3 m away → new Thing created and the old one missing (Review Focus 4); the same capture imported twice → BAD_REQUEST (Review Focus 5).

Commit: "inbox.importGeojson: a rescan moves matched Things and adds new ones instead of duplicating the set".

### Task 3: `room_scans`: a recorded version per scan, and revert

**Files:** `db/schema.ts` (new table), migration `0011_room_scans` (generated, additive: one CREATE TABLE, apply to test then live), `api/lib/roomScans.ts` (new), `api/routers/inbox.ts` (`importGeojson` records a row in its transaction), `api/routers/rooms.ts` (`upsertFromScan` records a row; new `scans`, `scanDiff`, `revertScan`), `api/test/roomScans.test.ts`, `AGENTS.md` §2.

**Schema** (`roomScans`, table `room_scans`): `id` serial; `roomId` bigint unsigned not null (index); `houseId` bigint unsigned not null; `captureId` bigint unsigned null; `source` varchar(32) (`geojson` | `roomplan` | `mappedin` | `manual`); `scanDate` timestamp not null; `createdAt` timestamp default now; `before` json null (`{ walls, openings, widthM, depthM, wallHeightM, scanDate }`, null on a room's first scan); `after` json same shape, not null; `changes` json not null: `Array<{ itemId: number; action: "matched" | "moved" | "created" | "missing"; posBefore: Pos | null; posAfter: Pos | null }>`; `revertedAt` timestamp null.

**Interfaces produced:**
- `recordRoomScan(tx, { roomId, houseId, captureId?, source, scanDate, before, after, changes })` → `scanId`. Called inside the import transaction after the merge, and by `upsertFromScan` with `changes: []`.
- `rooms.scans({ roomId })` → `Array<{ id, source, scanDate, createdAt, revertedAt, counts: { matched, moved, created, missing } }>` newest first.
- `rooms.scanDiff({ scanId })` → `{ scan: { id, roomId, source, scanDate, revertedAt }, before: Geometry | null, after: Geometry, changes: Array<change & { name: string; status: string }> }` (names joined from `items`; a deleted item gives name "(deleted)").
- `rooms.revertScan({ scanId })`: allowed only when the scan is the room's newest non-reverted scan (else CONFLICT "Only the latest scan of a room can be reverted"). In one transaction: room geometry and sizes and `scanDate` restored from `before` (first scan: walls, openings and sizes set to null); `moved`/`matched` Things get `posBefore` back; `created` Things are deleted when untouched (still `detected`, no decision, no photos, no pins, no relations) and otherwise kept but unlinked from the scan (left in place, logged); `missing` Things lose `scan.missing_at`; `revertedAt` set; room event `scan-reverted`. Returns `{ restored: number; deleted: number; kept: number }`.

Tests (seam): a first import records a scan with `before: null` and `changes` of `created`; a second import records `before` = first `after`, `changes` with `matched`/`moved`/`created`/`missing` as the merge did; `scans` lists both newest first with counts; `scanDiff` carries names; `revertScan` on the newest restores the earlier walls and positions, deletes untouched created Things, keeps a confirmed one, clears the missing flag, and a second `revertScan` on the same id is refused; reverting the older scan while a newer exists is refused; `upsertFromScan` (the iOS path) records a geometry-only row and reverting it restores the earlier geometry.

AGENTS.md: add `rooms.scans`, `rooms.scanDiff`, `rooms.revertScan` to the Workbench-facing contract list with one line of meaning; note that `upsertFromScan` and `importGeojson` each record a `room_scans` row.

Commit: "room_scans: every scan is a recorded version with before/after; the latest can be reverted".

### Task 4: Workbench: compare versions and revert

**Files:** `src/pages/RoomPlan.tsx` (a "Scans" panel next to the Photos panel), `src/components/RoomPlan2D.tsx` (new optional prop `ghostWalls?: Geometry["walls"]`, drawn dashed and faint under the live walls; nothing else changes), `src/components/ScanDiffList.tsx` (new).

- Panel lists `rooms.scans` rows: date, source, counts; the newest non-reverted one has "Undo this scan" (confirm inline, then `rooms.revertScan`, invalidate `rooms.get`, `items.listAll`, `rooms.scans`). Reverted rows are greyed with "undone <date>".
- Selecting a row loads `rooms.scanDiff` and (a) sets `ghostWalls` to its `before` walls so the previous outline shows under the current one, (b) renders `ScanDiffList`: moved Things with "from → to" in metres and a small arrow drawn on the plan from `posBefore` to `posAfter` (an SVG overlay inside RoomPlan2D via a new optional prop `moves?: Array<{ from: Pos; to: Pos; label: string }>`), created Things marked "new", missing Things marked "not in this scan". Clicking a Thing in the list selects it on the plan (existing `selectItem`).
- Product words: "Scan", "Thing", "Place" in copy; no "version" jargon beyond the date.

Gates: `npm run check`, eslint ≤ 31, build. Click-through on the test DB: import a floor GeoJSON twice with one polygon shifted and one removed (reuse the fixture from Task 2's test, written to the inbox via `POST /api/upload` + `inbox.create` + `inbox.importGeojson`), open the room plan: Scans panel shows two rows, selecting the first ghosts its outline, the list shows one moved (arrow on the plan), one missing; "Undo this scan" restores the position and clears the flag; console clean.

Commit: "Room plan: Scans panel compares a scan with the one before and undoes the latest".

### Task 5: Final review and landing

Final review (opus) against Review Focus, one fix round, scoped re-review, then Rick's go for the merge; restart :3001 after the merge (server code changed).
