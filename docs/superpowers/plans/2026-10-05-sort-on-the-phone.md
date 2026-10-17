# Sort On The Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Sorting from the phone works like a photo tool: every Photo can be zoomed, the AI's spotted objects are drawn as frames on the Photo, the queue can be browsed and a Photo picked to work on, and Skip survives a restart.

**Architecture:** `inbox.triage` asks the vision model for a bounding box per spotted object and stores it in the suggestion (`TriageSpottedItem.box`, the existing `CropBox` percent shape, centre + size). Clients draw the frames over the Photo and link a frame to its row. The iOS app gets a `PhotoViewer` (pinch, double-tap, pan) opened by tapping any `RemotePhoto`, a "Pick a Photo" grid in Sort, and a persisted skip order. Flow web gets the frames and the grid in its Sort tab.

**Spec:** Rick, 2026-10-05: "What does skip do in what is it? pane? It is just skipped for later (how)? It would be nice to browse the items and pick the one I want to add more context. Also we seem to have lost the frames in ai detection (ask ai what it is), it lists the objects it found but those not show them on the picture with pins/frames in the 'what is it?' pane. Also it is not possible to zoom in on a picture, on a phone that is mandatory for me."

## Global Constraints

- AGENTS.md §2: `inbox.triage` output only gains `box` on items; `inbox.acceptMany` input may gain an optional `box` per item (see Task 1); nothing else changes shape. `src/flow/` is now landed by this session (the Flow session closed on 2026-10-05).
- Worktrees: API `/Volumes/T7/declutter-sortapi` (branch `sort-triage-boxes`), Flow web `/Volumes/T7/declutter-sortflow` (branch `flow-sort-frames`), iOS `/Volumes/T7/declutter-sortios` (branch `ios-sort-phone`, created after `ios-snap-camera` and `scan-objects-ios` land). Baselines: 217+ tests, eslint 31.

## Contract

`TriageSpottedItem` gains `box?: { xPct: number; yPct: number; wPct: number; hPct: number } | null` — centre x/y and width/height as percent of the image, the same convention as `pins.detect` and `CropBox`. Missing or null when the model gave none.

`inbox.acceptMany` item input gains `box?: CropBox` (optional). When present and the capture has an image, the server creates the Thing as today and additionally a confirmed pin on the capture's photo (via the existing `photos.ensureForCapture` + pin creation path used by Annotate) and a cutout crop as the Thing's photo (the existing `photos.createCutout` logic). If that path is not reusable in one transaction without refactoring, Task 1 records `box` on the created pin only and reports; the cutout is then a follow-up.

## Review Focus

1. A triage answer without boxes (older model, or the model omits them): items still accepted, `box` null, clients draw nothing and show no error. Test in Task 1.
2. A box outside 0–100 or with zero size: rejected by zod and dropped from that item (box null), not the whole triage. Test in Task 1.
3. Frames must scale with the displayed Photo (object-fit contain vs cover): the overlay uses the same aspect box as the image; verified by click-through in Task 2 and 3.
4. Skip persistence: the skipped order is per device, keyed by capture id, pruned when a capture leaves the queue. Task 3.
5. Zoom viewer: double-tap toggles 1× / 3×, pinch between 1× and 6×, pan when zoomed, swipe down or Close to dismiss, works for cutout and full photos. Task 3.

---

### Task 1: API — boxes from triage, optional box on accept

**Files:** `db/schema.ts` (`TriageSpottedItem.box?`), `api/routers/inbox.ts` (`buildTriageContent`/the triage prompt and schema: ask for a tight box per spotted item with the same wording `pins.detect` uses in `api/routers/pins.ts`; zod `box` optional with 0–100 bounds and positive size, invalid → null; `acceptMany` optional `box` per item as per Contract), `api/test/inbox-triage-boxes.test.ts` (seam; the triage call itself is mocked or exercised through the dev-provider path that the existing tests use, check `api/test/` for how triage is tested today), `AGENTS.md` §2 (one line: `inbox.triage` items carry `box`; `inbox.acceptMany` accepts `box`).

Tests: suggestion with boxes stored and returned; without boxes (RF1); invalid box dropped (RF2); `acceptMany` with a box creates the pin (and the cutout when implemented) and without a box behaves as today (existing tests unchanged).

Commit: "inbox.triage returns a frame per spotted object; acceptMany can pin and crop it".

### Task 2: Flow web — frames and a Photo grid in Sort

**Files:** `src/flow/SortTab.tsx`, `src/flow/ui.tsx` (if a `Photo` variant with overlay children is needed), `src/flow/data.ts` (types from the API are inferred; nothing to add unless a helper is needed).

- In the "What is it?" card, draw a frame per `suggestion.items[i].box` over the Photo (absolute-positioned divs inside the Photo's aspect box, 2px lime border, number badge matching the row). Tapping a frame scrolls to and highlights its row and toggles its checkbox; the row shows the same number. Rows without a box have no number.
- Above the card list: a horizontal "Pick a Photo" strip of pending captures (thumbnails, 64px, the current one outlined); tapping one makes it the current card. Skipped ones go to the end, as today, and the skipped order is kept in localStorage (`flow.sort.skipped`, pruned to pending ids).
- Accepting rows passes `box` through to `inbox.acceptMany`.

Gates: `npm run check`, eslint ≤ 31, build. Click-through at 400px on the test DB (seed; a capture with a stored suggestion containing boxes can be inserted directly via the DB in a small script, since triage needs an LLM): frames drawn, tap selects row, strip jumps, skip order survives a reload.

Commit: "Flow Sort: frames on the Photo, a strip to pick a Photo, skip that survives a reload".

### Task 3: iOS — zoom viewer, frames, Photo grid, persisted skip

**Files:** `ios/DeclutterFlow/DeclutterFlow/PhotoViewer.swift` (new: full-screen zoomable viewer; `UIScrollView`-based or SwiftUI `MagnifyGesture` + `DragGesture`, double-tap 1×/3×, pinch 1–6×, pan, swipe-down/Close), `PhotoLoader.swift` (`RemotePhoto` gains `zoomable: Bool = true`: tap opens `PhotoViewer` with the loaded image, or loads full size via the same key), `Models.swift` (`TriageSpottedItem.box`), `SortView.swift` (frames overlay on the capture Photo in `CaptureCard` using the same aspect box; tap on a frame toggles the row; number badges; a "Pick a Photo" horizontal strip at the top of Sort; skip order persisted in `UserDefaults` key `flow.sort.skipped`, pruned to pending ids; rows pass `box` to `inboxAcceptMany`), `HomeBaseAPI.swift` (`inboxAcceptMany` sends `box`), project.pbxproj (new file).

Verify: simulator build; a unit-style check is not available, so a click-through in the simulator against the test DB with an inserted suggestion (same script as Task 2) using `xcrun simctl` + screenshots, or a careful code read if the simulator cannot reach the DB; say which.

Commit: "iOS Sort: zoom any Photo, frames for the AI's objects, pick a Photo from the queue, skip that sticks".

### Task 4: Review and landing

Final review per branch, one fix round each, Rick's go; API first (restart :3001), then Flow web (restart), then iOS.
