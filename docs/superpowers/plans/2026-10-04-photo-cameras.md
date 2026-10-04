# Photo Camera Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A photo can be placed on its room's 2D plan as a camera marker (position, heading, view cone) and shows in 3D as a small camera you can click to open the photo, like Google Maps photo pins; the marker is dragged into place or seeded from the pinned Things the photo contains, and can be set from the plan page, the Photos page and the item view's Placement pane.

**Architecture:** One additive nullable JSON column `photos.camera` (`{ xM, yM, headingDeg, fovDeg, heightM }` in the room frame, same frame as `items.pos`), reset when the photo changes room. Four procedures: `photos.setCamera`, `photos.roomPhotos` (the room's full photos with their camera, reusing the placement lib's room-photo query), `photos.suggestCamera` (a starting marker from the photo's pinned, placed Things) and the existing `photos.get`. `RoomPlan2D` draws markers (dot + cone, draggable, heading handle) behind a `cameras` prop; `RoomPlan3D` draws a cone mesh per camera with `userData.kind = "camera"` so picks never collide with item ids; `ItemRoomPreview` passes the room's cameras read-only; the plan page gets a "Photos" panel with "Place" and a selected-marker card (thumbnail, open in zoom, remove). Entry points: Photos tile action "Place on the plan", Placement pane pin rows show an "on the plan" state with the same action.

**Tech Stack:** as before (Drizzle/MySQL, tRPC 11, React 19 + Tailwind, SVG 2D, three.js 3D without r3f, vitest seam). Conventions and coordinates per the exploration of 2026-10-04: 2D `S = 70 px/m`, `PAD = 36`, `px = PAD + xM*S`; 3D world x = `xM − W/2`, world z = `yM − D/2`, y up; 2D rotation `rotate(−deg)` (CCW positive), 3D `rotation.y = +rad` (CCW from above); so a heading of 0° points to +x on both and increases counter-clockwise seen from above.

**Spec:** Rick, 2026-10-04: "on images/2d/3d plans … like Google Maps you can pin photos (not items) to specific spots and provide camera angle". Answered design: marker per photo, position + heading + cone, seeded from pinned Things, set from the plan page, the Photos page and the Placement pane, shown in 3D as a clickable camera.

## Global Constraints

- AGENTS.md §2: existing procedures unchanged; `src/flow/` untouched; `ItemRoomPreview`'s existing props keep working (new props optional); `RoomPlan2D`/`RoomPlan3D` gain optional props only. Migration is additive and numbered **after energy's 0009** (this plan starts only when `energy-part1` is on main; the camera migration is 0010). Worktree `/Volumes/T7/declutter-cameras`, branch `photo-cameras`; one commit per task; seam tests; baselines at start: whatever `main` reports then (expected 146 + energy's tests), eslint 31; production restart is Rick's.
- A camera lives in the photo's room frame: `photos.setCamera` requires `photos.roomId` set and `0 ≤ xM ≤ widthM`, `0 ≤ yM ≤ depthM` when the room has a size; any code path that changes `photos.roomId` (today: `attachPhotoToItem` when copying the Thing's room onto a room-less photo; `ensureLocationPhotoForCapture` when giving a later room) sets `camera = null` if the room actually changes.
- `headingDeg` in `[0, 360)`, `fovDeg` default 60 in `[20, 120]`, `heightM` default 1.5 in `[0, 5]`.
- Cutouts (`cropBox != null`) never get a camera: they are crops of a Thing, not a viewpoint. Only full photos (item-less room photos and location photos) do.

## Review Focus

1. Dragging a marker outside the room: clamped to the room bounds in 2D before `setCamera` is called; the server refuses out-of-bounds values anyway. Test in Task 1 (server) and Task 3 (click-through).
2. A photo whose room loses its size (`rooms.update` width to null): the marker stays stored but is not drawn (no frame); `roomPhotos` still returns it with `camera` so nothing is lost. Test in Task 1.
3. `suggestCamera` with no pinned placed Things: returns a marker at the room's centre facing +x with the default fov, flagged `basis: "center"`; with one or more pinned placed Things: `basis: "pins"`. Test in Task 1.
4. 3D click on a camera cone must not select an item and must not place a pin in pin mode. Test in Task 4 (code review) and the click-through.
5. A room photo attached to a Thing later (`attachToItem`) keeps its camera when the room does not change. Test in Task 1.

---

### Task 1: Column, migration 0010, `photos.setCamera`, `photos.roomPhotos`, `photos.suggestCamera`

**Files:** `db/schema.ts` (`camera: json("camera").$type<PhotoCamera>()` after `cropBox`; `export interface PhotoCamera { xM: number; yM: number; headingDeg: number; fovDeg: number; heightM: number }`), migration `0010_photo_camera` (one `ALTER TABLE photos ADD camera json`), `api/lib/photos.ts` (`setPhotoCamera`, the two room-change resets), `api/lib/placement.ts` (export the room-photo query as `roomPhotosFor(db, roomId, { forItemId?: number })` so `photos.roomPhotos` and `items.placement` share it; rows gain `camera`), `api/routers/photos.ts` (`setCamera`, `roomPhotos`, `suggestCamera`), `api/test/photo-cameras.test.ts`.

**Interfaces produced:**
- `photos.setCamera({ id: number; camera: PhotoCamera | null })` → `{ id, camera }`. Rules: photo exists, not a cutout, has `roomId`; bounds against the room's `widthM`/`depthM` when both are set; `headingDeg` normalised to `[0, 360)`; logs event `photo.camera` on the photo's item when it has one, else on the room (`entityType: "room"`).
- `photos.roomPhotos({ roomId: number })` → `Array<{ photoId, title, storageKey, itemId, itemName, isCutout, camera: PhotoCamera | null, pinCount }>` (full photos first, newest first, max 60).
- `photos.suggestCamera({ id: number })` → `{ camera: PhotoCamera, basis: "pins" | "center" }`: the photo's confirmed pins whose Things have `pos` in the photo's room give a centroid `c` (of the Things' centres); the camera stands on the room boundary point farthest from `c` along the ray from `c` through the room centre (clamped inside the room by 0.3 m), heading = angle from camera to `c`, fov = 60, height 1.5. With no such Things: room centre, heading 0.
- `placement` rows (`items.placement.roomPhotos`) gain `camera`.

Tests: setCamera happy path + bounds + cutout refused + no room refused; room-change resets (`attachPhotoToItem` onto a room-less photo keeps camera null, a photo with a camera attached to a Thing in the same room keeps it (Review Focus 5), `ensureLocationPhotoForCapture` giving a later room clears nothing because the camera was null); `roomPhotos` ordering and `camera`; `suggestCamera` both bases (Review Focus 3); unsized room keeps the stored marker (Review Focus 2).

Commit: "photos.camera: a photo stands somewhere in its room and looks in a direction".

### Task 2: 2D markers and the plan page's Photos panel

**Files:** `src/components/RoomPlan2D.tsx` (optional props `cameras?: CameraMarker[]`, `selectedCameraId?: number | null`, `onSelectCamera?(id)`, `onCameraChange?(id, camera)`, `cameraMode?: boolean`, `onCameraPlace?({ xM, yM })` where `CameraMarker = { id, title, camera: PhotoCamera }`), `src/pages/RoomPlan.tsx`.

- Marker drawing (a layer after items, before the handles): a 10 px dot at `(px(xM), py(yM))`, a translucent wedge of `fovDeg` around `headingDeg` with radius 1.2 m × S (CCW-positive like `rotDeg`), the photo's title on hover (`<title>`), selected = stronger stroke. Drag the dot to move (same pointer-capture pattern as items; clamped to the room; `onCameraChange` once on pointer-up); drag a small handle at the wedge's tip to rotate the heading; shift-drag the handle to widen/narrow `fovDeg` (±5° steps). `cameraMode` makes the floor click call `onCameraPlace` instead of `onPinPlace`.
- Plan page: a "Photos" panel under the item list: `photos.roomPhotos` rows (full photos only) each with a 48 px thumbnail (`photos.url`), title, and either "on the plan" (click selects the marker) or a "Place" button. Place → `photos.suggestCamera` → enter camera mode with the suggestion pre-drawn as a ghost; a click on the plan sets the position (heading from the suggestion), then `photos.setCamera`; Esc cancels. Selected marker card: thumbnail, "Open" (ZoomOverlay with the full image, `data-zoom-ignore` on the plan), "Suggest from pins" (re-runs suggestCamera and applies), "Remove from plan" (`setCamera(null)`, two-step like Remove volume). `?placePhoto=<photoId>` on load opens camera mode for that photo (notice if the photo is not in this room or is a cutout). Invalidate `photos.roomPhotos` and `items.placement` after writes.

Gates: check, eslint ≤ 31, build. Commit: "Plan page: photos stand on the 2D plan as camera markers".

### Task 3: 3D cameras and the item preview

**Files:** `src/components/RoomPlan3D.tsx` (optional `cameras?: CameraMarker[]`, `selectedCameraId`, `onSelectCamera`), `src/components/ItemRoomPreview.tsx`, `src/pages/Map.tsx`.

- 3D: per camera a `ConeGeometry(0.12, 0.3, 12)` mesh at `(xM − W/2, heightM, yM − D/2)`, rotated so the cone's axis points along the heading (cone tip forward; `rotation.y = degToRad(headingDeg)` after a base `rotation.z = −π/2`), accent material, `userData = { kind: "camera", id }`, kept in a separate `cameraMeshesRef`; a thin translucent `CircleGeometry` sector on the floor for the fov (optional; a `PlaneGeometry` wedge is fine). Click: intersect camera meshes first; a hit calls `onSelectCamera(id)` and returns (never `onSelect`, never `onPinPlace`; Review Focus 4). Selected camera gets emissive.
- `ItemRoomPreview`: loads `photos.roomPhotos({ roomId })` (enabled when the room is known), passes `cameras` to both views; a click on a marker opens that photo in the component's `ZoomOverlay` (`<img>` child, title) instead of the preview itself.
- Map page: the photo pool cards get a small "on the plan" badge when the photo's camera is set (needs `camera` on the pool rows: `photos.forRoom` is capture-based; add `camera` by joining the capture's location photo in the same query, additive), and a "Place on the plan" link to `/rooms/<roomId>?placePhoto=<photoId>` (after `ensureForCapture` as the Pin button does).

Gates as Task 2. Commit: "3D cameras: a cone per placed photo, click to open it".

### Task 4: Entry points, seed, click-through

**Files:** `src/pages/Photos.tsx` (bucket and room-photo tiles: "Place on the plan" when `roomId` set and not a cutout → `/rooms/<roomId>?placePhoto=<photoId>` after `ensureForCapture` for captures; badge "on the plan" from a `camera` field added to `CatalogRow`), `src/pages/ItemDetail.tsx` (Placement pane pin rows show "· on the plan" or a "Place" link for each photo the Thing is pinned in; `items.placement.pins` rows gain `camera` (additive, Task 1 exposes it via the pin's photo)), `scripts/seed-test-db.mjs` (a camera on "Keuken overview": `{ xM: 1.6, yM: 3.8, headingDeg: 90, fovDeg: 60, heightM: 1.5 }` looking at the kettle wall; JSON line unchanged), `AGENTS.md` §2 (photos bullet gains `photos.setCamera`, `photos.roomPhotos`, `photos.suggestCamera`; Data meaning: "A photo's `camera` is where it was taken in its room frame: `xM, yM, headingDeg (0 = +x, counter-clockwise), fovDeg, heightM`; cutouts have none").

Click-through (controller, dev server on the test DB, Chrome):
1. `/rooms/1` (Keuken): the Photos panel lists "Keuken overview · on the plan"; the 2D plan shows its dot and cone near the bottom wall pointing up; 3D tab shows a cone; clicking the cone opens the photo in the zoom overlay.
2. Drag the marker to the room centre and the heading handle to the right: `photos.get` shows the new `camera`; Esc/none written otherwise.
3. Pin the Lamp in the capture's location photo (from the earlier plan's seed flow or via Annotate), then on `/rooms/1` choose "Place" for that photo: a ghost appears from `suggestCamera` with `basis: "pins"`; click to confirm; the marker appears; "Remove from plan" (two-step) removes it.
4. `/photos`: "Keuken overview" shows the "on the plan" badge; the pending capture's row has "Place on the plan" → lands on `/rooms/1?placePhoto=…` in camera mode.
5. `/items/1` (Waterkoker): the Placement pane's pin row reads "Keuken overview · on the plan".
6. `/rooms/2?placePhoto=6` (photo of Keuken on Zolder): notice, nothing written. Console: no errors; network: no 4xx/5xx.

Commit: "Photos stand on the plan from the Photos page and the item view; seed camera".

### Task 5: Land

Final review (opus) on `main..photo-cameras`, one fix round, merge, worktree removal, Rick's restart; AGENTS.md line to the Flow session (the Twin view may want `camera` from `photos.listAll`).
