# Scan Objects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** A LiDAR scan from the iOS app creates and updates detected Things for the objects RoomPlan found (tables, chairs, storage, beds, sofas, appliances), the same way the MappedIn GeoJSON import does, through the same rescan merge, so the 2D/3D plan after a scan shows the room's contents and not only its walls.

**Architecture:** `rooms.upsertFromScan` gains an optional `objects` list in the plan frame. The merge that `inbox.importGeojson` runs today (match by `scan_kind` and distance, move matched Things, insert new, flag missing, record the `room_scans` changes) moves into one shared function used by both callers. The iOS app converts each `CapturedRoom.Object` to a footprint in the same straightened plan frame as the walls and sends it.

**Tech Stack:** as before. No schema change.

**Spec:** Rick, 2026-10-05: "I scanned kantoor and took some photos of the room. The 2d/3d scan are basically empty, just outerwalls, no objects? I expected same output as mappedin."

## Global Constraints

- AGENTS.md §2: `rooms.upsertFromScan` keeps its inputs and outputs; it gains optional `objects` and optional output counts. `inbox.importGeojson` behaviour and tests unchanged. No edits under `src/flow/`.
- Two worktrees: API in `/Volumes/T7/declutter-scanobj` (branch `scan-objects-api`), iOS in `/Volumes/T7/declutter-scanobj-ios` (branch `scan-objects-ios`), both from main d8d57f7. The iOS branch is rebased on the API branch before landing; the API lands first.
- Shared test DB: wait until `pgrep -f 'node.*vitest'` is empty. Baselines: 217 tests, eslint 31.

## Contract (both sides build to this)

`rooms.upsertFromScan` input gains:
```ts
objects?: Array<{
  kind: string;          // RoomPlan category name in lower camel case: storage, refrigerator, stove, bed, sink, washerDryer, toilet, bathtub, oven, dishwasher, table, sofa, chair, fireplace, television, stairs (max 32 chars; unknown kinds are accepted and become topic "furniture" with the kind as label)
  xM: number; yM: number; // min corner of the footprint in the plan frame (same frame as walls: metres, origin at the room's min corner, y down the plan)
  wM: number; dM: number; // footprint size along plan x and plan y, ≥ 0.1
  rotDeg?: number;        // rotation of the footprint about its centre, same sign as items.pos.rotDeg (web RoomPlan2D draws `rotate(-rotDeg cx cy)` in a y-down SVG; web 3D sets rotation.y = rotDeg in radians); default 0
  hM?: number;            // height
}>  // max 200
```
Output gains `{ matched, moved, created, missing }` next to the existing `{ id, created }` (`created` keeps its meaning: the room row was created). Name the Thing counts `things: { matched, moved, created, missing }` to avoid a clash.

Server kind map (api/lib/geojsonFloor.ts `FURNITURE_KIND_MAP`) gains: `refrigerator` → appliances "Fridge" hM 1.8; `bed` → furniture "Bed" hM 0.5; `washerDryer` → appliances "Washer" hM 0.85; `bathtub` → furniture "Bathtub" hM 0.6; `dishwasher` → appliances "Dishwasher" hM 0.85; `fireplace` → furniture "Fireplace" hM 1.0. Existing kinds unchanged. When the topic's area does not exist in the house, fall back to the area with slug `furniture`, then to the first area, instead of skipping the object (importGeojson keeps its current skip for GeoJSON).

## Review Focus

1. A scan with objects on a room that already has scan-created Things: matched by `scan_kind`, moved, not duplicated; the `room_scans` row carries the changes; `revertScan` undoes them. Test in Task 1.
2. The iOS rotation sign: an object rotated +30° in RoomPlan ends up drawn at the same angle on the web plan; the same straightening rotation is applied to objects and walls. Task 2 unit test on the pure converter.
3. Objects partly outside the walls (RoomPlan sometimes places a cabinet through a wall): keep them, clamp nothing; `widthM`/`depthM` of the room stay the wall box. Task 2.
4. A scan with `objects: []` behaves exactly like today's geometry-only scan (no Things touched, no missing flags). Test in Task 1.
5. Unknown kind: accepted, label is the kind capitalised, topic furniture. Test in Task 1.

---

### Task 1: API — shared merge, `objects` on `upsertFromScan`

**Files:** `api/lib/scanObjects.ts` (new: `mergeScanObjects(tx, { roomId, houseId, roomName, polys: ScanPoly[], source }) → { changes: RoomScanChange[], counts }` extracted from the item loop of `inbox.importGeojson`; the room's active Things load, `matchScanItems`, the repair step, updates, inserts with `scan_kind`, missing flags, item events; area fallback as a parameter so GeoJSON keeps skipping), `api/routers/inbox.ts` (calls it; behaviour identical, existing tests must pass unchanged), `api/routers/rooms.ts` (`upsertFromScan`: zod for `objects`, map kinds to polys via `FURNITURE_KIND_MAP`, call `mergeScanObjects` inside its existing transaction before `recordRoomScan`, pass the changes, return `things` counts), `api/lib/geojsonFloor.ts` (new kinds), `api/test/scanObjects.test.ts`, `AGENTS.md` §2 (iOS bullet: `rooms.upsertFromScan` with `objects`; Data meaning unchanged).

Tests: first scan with 3 objects creates 3 detected Things with `scan_kind` and `pos` (incl. `rotDeg`, `hM`); second scan with one moved 0.3 m, one removed, one new → counts `{ matched: 2, moved: 1, created: 1, missing: 1 }`, same ids, `room_scans` changes recorded, revert restores (Review Focus 1); `objects: []` → no Thing changes (RF4); unknown kind `plant` → "Plant", topic furniture (RF5); missing area falls back to furniture; the existing inbox-location and roomScans tests unchanged and green; full `npm test`.

Commit: "Scans carry their objects: upsertFromScan creates and merges detected Things like the GeoJSON import".

### Task 2: iOS — send RoomPlan objects

**Files:** `ios/DeclutterFlow/DeclutterFlow/RoomPlanGeometry.swift` (`payload(from:)` also returns `objects`; a pure `objectFootprint(_: CapturedRoom.Object, rotation: Double, origin: SIMD2<Double>) → ScanObjectPayload` that takes the object's `transform` (translation x,z → plan via the same `y = +z` rule, yaw about y from the rotation matrix) and `dimensions` (x = width, z = depth, y = height), applies the same straightening angle and origin shift as the walls, and emits `xM,yM` = centre − half size, `wM,dM`, `rotDeg` normalised to (−90, 90], `hM`; derive the sign of `rotDeg` from the frame conventions in the contract and write it down in a comment), `Models.swift` (`ScanObjectPayload`, `RoomGeometryPayload.objects`), `HomeBaseAPI.swift` (`roomsUpsertFromScan` sends `objects`, decodes `things`), `RoomScanFlow.swift` (after save: show "N Things found, M moved" from `things`, then `session.refresh()` so the plan shows them), `RoomDetailView.swift`/`FloorPlanView.swift` (nothing new: items already draw), `ios/README.md`.

Tests: an XCTest target does not exist; add `ios/DeclutterFlow/DeclutterFlowTests` only if it is cheap (one file, pure functions). Otherwise verify the converter with a small Swift script run by `swift` on the Mac using the same pure functions copied into the script (no RoomPlan import needed: feed a 4×4 transform and dimensions). Cases: identity transform at (1, 2) with size 0.8×0.4 → `xM 0.6, yM 1.8, wM 0.8, dM 0.4, rotDeg 0`; yaw +30° → `rotDeg` with the sign the comment claims; straightening angle 90° applied to both a wall and an object keeps their relative position.

Build gate: `xcodebuild -project DeclutterFlow.xcodeproj -scheme DeclutterFlow -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build CODE_SIGNING_ALLOWED=NO` → BUILD SUCCEEDED, no new warnings.

Commit: "iOS scan sends the objects RoomPlan found, so a scan fills the plan like the GeoJSON import".

### Task 3: Review and landing

Final review (opus) of both branches against Review Focus, one fix round each, then Rick's go: API first (restart :3001), then iOS rebased on it.
