# Photo Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Photos in the bucket (captures and item-less photos) get a one-click "attach to an existing Thing" and "pin a Thing in this photo"; every Thing shows whether it is pinned in a photo, placed on the 2D plan and visible in 3D; the item view gets a "Placement" pane that says what is still missing for its room with a direct action for each gap; the plan page can place an existing unplaced Thing.

**Architecture:** Two additive procedures: `photos.attachToItem` (sets `photos.itemId`, and `roomId` from the Thing when the photo has none) and `items.placement` (one Thing: confirmed pins, on-plan flag, the room's candidate photos) plus `items.placementSummary` (many Things: pin count and on-plan flag, one query each, for badges). Annotate gains `?itemId=` to preselect the Thing for the next pin; RoomPlan gains `?placeItem=` and a Place button for unplaced Things of the room (click sets `items.update({ pos })`, as pin mode does for new Things). The Photos page gets tile actions and badges; ItemDetail a Placement pane. "On the plan" and "in 3D" are one fact (`roomId` and `pos` set); the pane says so.

**Tech Stack:** as before: tRPC 11 + Drizzle/MySQL, React 19 + Tailwind + lucide, vitest seam, `ItemPicker` component.

**Spec:** Rick, 2026-10-04: "in the photos bucket there are items, these items need easy way to attach to existing items and to be placed in room images, we need a way to show if items are pinned in images, 2d, 3d plans" and "a seen in photos can also show a not seen in photos/2d/3d pane for the relevant room". Facts from the exploration of the same day: no procedure sets `photos.itemId`; pins come from `pins.add` on `/annotate/:photoId` (only `?roomId` today); `items.pos` is written only by `items.update`; RoomPlan's pin mode creates new Things only; Flow never uses pins or `pos` except in the preview.

## Global Constraints

- AGENTS.md §2: every existing procedure keeps its inputs and outputs; `inbox.*`, `items.update` (incl. its pos-reset rule when `roomId` changes), `ItemRoomPreview` props and `isUnplaced` (roomId null) stay as they are, so Flow is untouched; `src/flow/` is not edited.
- No schema change. No new dependencies. Worktree `/Volumes/T7/declutter-placement`, branch `photo-placement`; one commit per task; tests on the seam only; baselines: 135 tests, eslint 31; production restart is Rick's.
- A capture is never attached directly: the caller first calls `photos.ensureForCapture({ captureId })` and attaches the resulting photo (the capture stays in the inbox until triaged, as today).
- `photos.attachToItem` never moves a photo that already belongs to another Thing unless `force: true` is passed (the UI asks "Move from X?").

## Review Focus

1. Attaching a photo whose `roomId` is set to a Thing in another room: the photo keeps its own room (it shows where it was taken); the Thing's room is not changed. Test in Task 1.
2. A Thing with `pos` but whose room has no geometry: "on plan" is true (the plan page works with width/depth), the pane says 3D needs a scan only when the room has neither walls nor dimensions. Test in Task 1 (`placement` flags) and Task 5 (copy).
3. `?placeItem=` for a Thing that is not in that room (or already placed): the plan page ignores it with a notice, never writes. Test in Task 3 (click-through) and unit-level in Task 1 (`items.update` guard unchanged).
4. The Photos page badges for hundreds of tiles: one `items.placementSummary` call per page, not per tile. Task 4 code review.
5. Attach from the bucket when the Thing is archived: refused (BAD_REQUEST). Test in Task 1.

---

### Task 1: `photos.attachToItem`, `items.placement`, `items.placementSummary`

**Files:** `api/lib/photos.ts` (`attachPhotoToItem`), `api/routers/photos.ts` (`attachToItem`), `api/lib/placement.ts` (new: `placementFor`, `placementSummaryFor`), `api/routers/items.ts` (`placement`, `placementSummary`), `api/test/placement.test.ts`.

**Interfaces produced:**
- `photos.attachToItem({ photoId: number; itemId: number; force?: boolean })` → `{ photoId, itemId, roomId }`. Rules: photo must exist and be a real photo (not a capture row); Thing must exist and be active (else BAD_REQUEST); if the photo has another `itemId` and `force` is not true → CONFLICT `{ message: "Photo belongs to <name>" }`; sets `itemId`; if the photo's `roomId` is null, copies the Thing's `roomId`; logs event `photo.attached` on the item; returns the row's ids. Does not touch pins or cover photos (the existing cover logic reads photos by item, so the attached photo becomes a candidate automatically).
- `items.placement({ itemId })` → `{ itemId, roomId, roomName, roomHasGeometry, roomHasDimensions, onPlan: boolean (roomId != null && pos != null), pins: Array<{ pinId, photoId, title, label }> (confirmed only), photos: number (photos with this itemId), roomPhotos: Array<{ photoId, title, hasPinForItem }> (item-less photos with that roomId plus the room's other Things' photos via the same query `photos.forRoom` uses, de-duplicated, newest first, max 30) }`.
- `items.placementSummary({ itemIds: number[] (1..500) })` → `Array<{ itemId, pinCount, onPlan }>` in two queries (pins grouped by itemId, items' roomId/pos).

Tests (seam, `api/test/placement.test.ts`): attach to an active Thing sets itemId and copies roomId when null; keeps the photo's own roomId when set (Review Focus 1); refuses a capture-less photo id, an archived Thing (Review Focus 5), and a photo owned by another Thing without `force` (CONFLICT), moves it with `force`; `placement` reports pins (confirmed only), `onPlan` with and without room geometry (Review Focus 2), roomPhotos; `placementSummary` for three Things in one call.

Commit: "photos.attachToItem and items.placement: attach a bucket photo to a Thing, know where a Thing is placed".

### Task 2: Annotate preselects a Thing; RoomPlan places an existing Thing

**Files:** `src/pages/Annotate.tsx`, `src/pages/RoomPlan.tsx`.

- Annotate: read `?itemId=` (next to `?roomId=`); when set and the Thing loads (`items.get`), prefill `pendingItem` and `pendingLabel` with the Thing's name, show a banner "Pinning: <name> · draw a box on the photo" with a Cancel that clears the preselection; after the pin is saved (existing flow, cutout included), navigate back to `/items/<id>` when `?back=item` is present, else stay. Nothing else changes.
- RoomPlan: a "Place" button on each unplaced Thing in the room's list (today text only) and `?placeItem=<id>` on load: both enter "place mode" for that Thing (banner "Click where <name> stands", Esc cancels). A click on the plan calls `items.update({ id, pos: { xM, yM, wM: 0.5, dM: 0.5, rotDeg: 0 } })` through the same `applyStacking` helper pin mode uses, then exits place mode; the Thing is selected afterwards. `?placeItem` for a Thing not in this room or already placed shows a notice and does nothing (Review Focus 3). Flow untouched.

Gates: `npm run check`, eslint ≤ 31, build. Commit: "Annotate pins a preselected Thing; the plan page places an existing Thing".

### Task 3: Photos page: bucket actions and placement badges

**Files:** `src/pages/Photos.tsx`, `src/components/AttachPhotoDialog.tsx` (new).

- Bucket tiles (captures and photos with `itemId` null) get a small action row on hover/focus (always visible on touch): "Attach to Thing…" and "Pin a Thing…". Attach opens `AttachPhotoDialog` with `ItemPicker` (existing component: `placeholder/value/onQueryChange/onSelect/allowCreate/onCreateNew`; allowCreate false here); on select: for a capture first `photos.ensureForCapture({ captureId })`, then `photos.attachToItem({ photoId, itemId })`; on CONFLICT show "Move from <name>?" with a Move button (`force: true`); on success invalidate `photos.listAll` and show "Attached to <name>" with a link. "Pin a Thing…" navigates to `/annotate/<photoId>?roomId=<roomId|none>` (after `ensureForCapture` for a capture).
- Badges on Thing tiles (`itemId` set): one `items.placementSummary` call for the visible item ids (useMemo of ids → single query); a pin icon with the count when `pinCount > 0`, a plan icon when `onPlan`; both greyed when missing, with titles "Pinned in N photo(s)" / "Not pinned in any photo", "Placed on the plan" / "Not placed on the plan".
- A filter chip "Not placed" (Things with no pin or not on plan) next to the existing "Items" checkbox.

Gates as Task 2. Commit: "Photos page: attach a bucket photo to a Thing, pin from the tile, placement badges".

### Task 4: Item view: the Placement pane

**Files:** `src/pages/ItemDetail.tsx` (new `PlacementPane` next to `PinnedInPhotos`; `PinnedInPhotos` may become part of it), `src/components/ui/*` untouched.

- Reads `items.placement({ itemId })`. Three rows:
  1. **Photo** — pinned: "Seen in N photo(s)" with the existing links; not pinned: "Not pinned in a photo yet" and, when `roomPhotos` is non-empty, "Pin in a photo of <room>" → a small list of those photos (thumbnail via `photos.url`, title) each linking to `/annotate/<photoId>?itemId=<id>&back=item`; when empty: "No photo of <room> yet" with a link to `/photos?room=<roomId>` (the Photos page already groups by room; a query param selecting the group is optional).
  2. **2D plan** — on plan: "Placed on the plan of <room>" + "Open plan" (`/rooms/<roomId>`); not placed, room set: "Not on the plan yet" + button "Place on the plan" → `/rooms/<roomId>?placeItem=<id>`; no room: "Give it a room first" (the existing room picker).
  3. **3D** — same fact as the plan: placed and the room has walls or dimensions → "Visible in 3D" (the existing preview opens it); placed but no geometry at all → "Scan or size the room to see it in 3D"; not placed → "Appears once it is on the plan".
- Keep the existing `ItemRoomPreview` block.

Gates as Task 2. Commit: "Item view: a Placement pane that says where the Thing is, and is not yet, placed".

### Task 5: Seed and click-through

**Files:** `scripts/seed-test-db.mjs` (add: Keuken walls = a 3.2×4.1 rectangle, `pos` on Waterkoker and Broodrooster, one item-less photo in Keuken (`writeTestJpeg`-style copy of an existing seed JPEG, `roomId` keuken, title "Keuken overview"), one confirmed pin of Waterkoker in it), and the JSON line gains `photos.keukenOverview` and `pins.waterkoker`.

Click-through (controller, dev server on the test database, Chrome):
1. `/photos` with "Items" unticked: the pending capture and "Keuken overview" show the action row; Waterkoker's tile shows pin badge 1 and plan badge on; Broodrooster plan on, pin off; Stoel both off; "Not placed" chip lists Stoel, Lamp, Doos, X220, SSD, Pan (per house scope).
2. On "Keuken overview" choose "Attach to Thing…" → pick "Stoel" → "Attached to Stoel"; the tile moves out of the bucket; read-back `photos.listAll` shows itemId = Stoel, roomId = Keuken (its own room kept, Review Focus 1).
3. On the pending capture choose "Pin a Thing…" → Annotate opens on a new location photo; draw a box; pick "Lamp (detected)"; save → `/items/4` "Seen in photos" lists it; Photos tile badge for Lamp shows pin 1.
4. `/items/3` (Stoel): Placement pane: Photo "Seen in 0" with "Pin in a photo of Zolder" (no Zolder photos → "No photo of Zolder yet" link); 2D "Not on the plan yet" + "Place on the plan" → `/rooms/2?placeItem=3` → banner → click on the plan → read-back `items.get` pos set → pane says "Placed on the plan of Zolder", 3D "Scan or size the room…" (Zolder has no size) — then `/items/1` (Waterkoker): all three positive, 3D "Visible in 3D".
5. `/rooms/2?placeItem=1` (Waterkoker is in Keuken, not Zolder): notice, nothing written.
6. Console: no errors; network: no 4xx/5xx except an expected CONFLICT when re-attaching "Keuken overview" to Broodrooster without force (then Move works).

Commit: "Seed: walls, positions, a room photo and a pin for the placement click-through". Then final review (opus), one fix round, merge to main, worktree removal, Rick's restart.
