# UI Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicate paths the 2026-11-06 modal/viewer review found in the Workbench (batched photo URLs with server-side size for the three grids, one capture→Photo promotion, one atomic frame→Thing call, one crop dialog, one Place picker), then the measured performance smells, then two functional gaps, without touching `src/flow/` or any contract in `AGENTS.md` §2.

**Checked by:** `docs/consolidation-plan-check.md` (PR #53, 2026-11-06): all findings confirmed on `2ac71b8`; its nine amendments are folded in below (Task 3 file list, Task 4 input, Task 7 scope, Task 12 test, `AGENTS.md` steps, PR sequencing, out-of-scope list). It cites `docs/repo-review.md` and `docs/pr-audit.md`, which are not in the repo; ignore those references.

**Architecture:** Server first where the server already has the better path (`photos.urls`, `inbox.acceptMany`-style transactions), then a small set of shared hooks/components in `src/hooks` and `src/components` that the pages call. Every task ends with `npm run check`; API tasks add a vitest in `api/test/`; pure helpers in `src/lib` get vitest tests too (Task 1 wires that up). New tRPC procedures are added, never renamed.

**Tech Stack:** React 18 + Vite, tRPC v11 (`httpBatchLink`), TanStack Query, Drizzle/MySQL, vitest, Radix UI (`src/components/ui`), Tailwind.

**Spec:** The review itself: the interactive map at https://claude.ai/artifact/UyWNqYYkmyARakgvhjysar and the "Findings" section below, which repeats the facts the plan argues from together with the command that verifies each one. Run those commands first; if a count differs, the codebase moved and the task that depends on it must be re-read before it is executed.

## Global Constraints

- `AGENTS.md` §1: do not edit `flow/` or `src/flow/`. If `npm run check` fails only under `src/flow/`, stop and tell Rick.
- `AGENTS.md` §2: never remove or rename a listed tRPC procedure or change its inputs/outputs incompatibly. Adding optional input fields and new procedures is allowed. `attachments.url` stays (Flow uses it).
- `AGENTS.md` §3: schema changes only through `db/schema.ts` + `npm run db:generate -- --name <short-name>`; this plan contains **no schema change**.
- `AGENTS.md` §4: work in a worktree (`git worktree add ../declutter-ui-consolidation -b ui-consolidation origin/main`), `npm run check` must pass before every push, `npm test` after every API task, merge to `main` only when Rick says so.
- Tests run against `TEST_DATABASE_URL` (`declutter_test`); never `DATABASE_URL`. One suite at a time (`fileParallelism: false`).
- Product words in copy: Thing, Place, Photo, Decision, Lens.
- No new npm dependencies.

## Review Focus

1. A capture that is already a Photo (`photos.ensureForCapture` called twice) must not create a second Photo — pinned in Task 3's hook by reusing the server's find-or-create (no client cache of photoIds across dialogs).
2. `photos.fileFrame` with `itemId: null` and no `itemName` must be `BAD_REQUEST`, never an unnamed Thing — Task 4 test (c).
3. A `photos.urls` request with more than 200 keys must be chunked client-side, never rejected by the server — Task 2 `chunkKeys` test.
4. Re-saving the same crop box must not create a second cutout — unchanged server dedupe (`createCutout` dedups per capture); Task 4 test (e) pins it for `fileFrame`.
5. `inbox.create` with an unknown `roomId` must be `BAD_REQUEST` ("Place not found."), and a room in another house than `x-house-id` must place the snap there and set the capture's house to that room's house — the same rule as `inbox.assignPlace` ("room wins and sets the house") — Task 12 tests (b) and (c).

---

## Findings (spec) and how to verify them

Run from `/Volumes/T7/declutter` on `main` ≥ `594f63a`.

| # | Finding | Verify | Expected |
|---|---|---|---|
| F1 | `photos.urls` (batch, returns `width`/`height`) has no UI caller; the Workbench issues per-key `photos.url` queries and probes aspect with `new Image()` / `onLoad` | `grep -rn "photos.urls" src \| grep -v src/flow \| wc -l` and `grep -rln "new Image()" src/components` | `0`; `ItemPinSchematics.tsx` |
| F2 | `photos.ensureForCapture.useMutation` appears at 10 UI sites in 6 files (RoomPhotoCard:36, AttachPhotoDialog:51, ChooseFromLibraryDialog:56, PhotoPlaceDialog:97, Inbox:175/326/332, Photos:100/105/111) with 2 copies of the photo\|capture union | `grep -rn "ensureForCapture.useMutation" src \| grep -v src/flow \| wc -l` | `10` |
| F3 | Annotate and Focus create a Thing from a frame with 3 client mutations (`items.create` → `photos.createCutout` → `pins.update`), not atomically | `grep -n "createCutout.useMutation" src/pages/Annotate.tsx src/pages/Focus.tsx` | 1 hit each |
| F4 | Three crop UIs share the same `img + Box` layout; `Box` lives in `DetectObjects.tsx`; `CropBox` is declared 5× | `grep -rn "type CropBox = {" src \| wc -l` | `5` |
| F5 | "Pick a room" dialogs re-implemented in ItemDetail, AllItems, Inbox | `grep -n "<RoomPicker" src/pages/ItemDetail.tsx src/pages/AllItems.tsx src/pages/Inbox.tsx \| wc -l` | `≥ 3` |
| P1 | `ItemPinSchematics` runs `pins.listForRoom` once per room of the Thing | `grep -n "useQueries" src/components/ItemPinSchematics.tsx` | line 45 |
| P2 | `RoomPlan3D` rebuilds every mesh when `selectedCameraId` changes | `grep -n "selectedCameraId\]" src/components/RoomPlan3D.tsx` | in the rebuild effect's deps |
| P3 | `RoomPlan2D` is not memoised | `grep -c "memo(" src/components/RoomPlan2D.tsx` | `0` |
| P4 | `Model3dViewer` recreates the renderer per `src` | `grep -n "}, \[src\]);" src/components/Model3dViewer.tsx` | line 160 |
| P5 | `ItemRoomPreview` renders itself inside its own overlay (second `rooms.get`) | `grep -n "<ItemRoomPreview" src/components/ItemRoomPreview.tsx` | 1 hit (self) |
| G1 | The Workbench item page has no Decision control | `grep -c "setDecision" src/pages/ItemDetail.tsx` | `0` |
| G2 | A snap's Place is only remembered client-side (Flow `localStorage`); `inbox.create` takes no `roomId` | `grep -n "roomId" api/routers/inbox.ts \| sed -n '1,3p'` and lines 384-412 | no `roomId` in `create`'s input |

Not in this plan (needs its own brainstorm): linking a photo pin to a plan position (`items.pos` ↔ `photo_pins`); Flow-owned items (`src/flow` Sheet, ZoomViewer, client queue rules, `attachments.url`). Still-open leftovers from the 5 Oct review that this plan does not touch and that should not be forgotten: close draft PR #5 (the 4 Oct iOS app), fix the README route table's `/snap` row, add a `.github/` workflow that runs `npm run check` and `npm test`.

**Open pull requests and this plan** (from the check; state as of `439b37d`, 2026-11-06 evening):
- **#22** landed on `main` as `c8b15ab` ("Name Focus hand-drawn frames with claude -p after create"; PR closed). `src/pages/Focus.tsx` and `api/routers/pins.ts` moved: **re-run the Findings greps and re-read `Focus.tsx` (`admit`) before Tasks 1 and 4.** `pins.labelWithClaude` stays a draw-time naming step: do not fold it into `fileFrame`, do not delete it when `admit` is rewritten.
- **#54** landed (`439b37d`): `normalizeDetectBox` / `forDetectVision` in `api/lib/detectMatch.ts` + `crop.ts`, used by `pins.detect` and `inbox.detectObjects`; `AGENTS.md` §2 has a "Detect boxes" line. Nothing left to port from #23.
- **#29** merged (`dbab631`, `15a62c2`): independent files.
- **#23** and **#5** closed on 2026-11-06 (branches kept).

## File Structure

Create:
- `src/lib/cropBox.ts` — `CropBox` type, `DEFAULT_CROP_BOX`, `frameRect`, `boxesEqual` (pure).
- `src/lib/cropBox.test.ts`
- `src/lib/photoUrls.ts` — `chunkKeys` (pure). `src/lib/photoUrls.test.ts`
- `src/hooks/use-photo-urls.ts` — `usePhotoUrls` over `photos.urls`.
- `src/hooks/use-photo-from-target.ts` — `PhotoTarget`, `usePhotoFromTarget`, `invalidatePhotoChange`.
- `src/components/CropBox.tsx` — the `Box` component moved out of `DetectObjects.tsx`.
- `src/components/CropDialog.tsx` — one full-screen crop dialog.
- `src/components/PlacePickerDialog.tsx` — one "pick a Place" dialog around `HouseRoomFields`.
- `src/components/DecisionButtons.tsx` — Workbench decision control (Task 11).
- `api/lib/fileFrame.ts` — `fileFrame` transaction. `api/test/photos-fileFrame.test.ts`
- `api/test/pins-forItemPhotos.test.ts`, `api/test/inbox-create-room.test.ts`

Modify (exact ranges are as of `594f63a`; re-check after #22 lands): `vitest.config.ts`; `AGENTS.md` §2 (three contract lines, one per new procedure/input: Tasks 4, 7, 12); `api/routers/photos.ts` (add `fileFrame`; extract `createCutout` body); `api/routers/pins.ts` (add `forItemPhotos`); `api/routers/inbox.ts:384-412` (`create` gains `roomId`); `src/components/ui/dialog.tsx` (`size="full"`); `RoomSchema.tsx`, `ItemPinSchematics.tsx`, `RoomPhotoPool.tsx`, `RoomPhotoCard.tsx`, `AttachPhotoDialog.tsx`, `PhotoPlaceDialog.tsx`, `ChooseFromLibraryDialog.tsx`, `RecropDialog.tsx`, `PhotoCropZoom.tsx`, `DetectObjects.tsx`, `RoomPlan2D.tsx`, `RoomPlan3D.tsx`, `Model3dViewer.tsx`, `ItemRoomPreview.tsx`; `src/pages/Annotate.tsx`, `Focus.tsx`, `ItemDetail.tsx`, `AllItems.tsx`, `Inbox.tsx`, `Photos.tsx`.

---

# Phase A — Top 5

### Task 1: Shared `CropBox` helpers and a test runner for `src/lib`

**Files:**
- Modify: `vitest.config.ts` (`test.include`)
- Create: `src/lib/cropBox.ts`, `src/lib/cropBox.test.ts`
- Modify: `src/components/ChooseFromLibraryDialog.tsx:13`, `src/components/PhotoCropZoom.tsx:8-14`, `src/components/RecropDialog.tsx:13`, `src/pages/Focus.tsx:36`, `src/pages/Annotate.tsx:32`

**Interfaces:**
- Produces: `export type CropBox = { xPct: number; yPct: number; wPct: number; hPct: number }`; `export const DEFAULT_CROP_BOX: CropBox = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 }`; `export function frameRect(b: CropBox): { left: number; top: number; width: number; height: number }` (percent; centre+size → top-left+size); `export function boxesEqual(a: CropBox, b: CropBox): boolean`.

- [ ] **Step 1: Add `"src/lib/**/*.test.ts"` to `test.include` in `vitest.config.ts`** (keep `environment: "node"`; these tests touch no DB — `globalSetup` still runs, that is acceptable).

- [ ] **Step 2: Write the failing test** `src/lib/cropBox.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CROP_BOX, boxesEqual, frameRect } from "./cropBox";

describe("frameRect", () => {
  it("turns a centre+size box into a top-left rect in percent", () => {
    expect(frameRect({ xPct: 50, yPct: 50, wPct: 40, hPct: 20 })).toEqual({ left: 30, top: 40, width: 40, height: 20 });
  });
  it("lets a frame reach the left edge exactly", () => {
    expect(frameRect({ xPct: 10, yPct: 10, wPct: 20, hPct: 20 }).left).toBe(0);
  });
});
describe("boxesEqual", () => {
  it("compares the four fields", () => {
    expect(boxesEqual(DEFAULT_CROP_BOX, { ...DEFAULT_CROP_BOX })).toBe(true);
    expect(boxesEqual(DEFAULT_CROP_BOX, { ...DEFAULT_CROP_BOX, wPct: 41 })).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**: `npx vitest run src/lib/cropBox.test.ts` → FAIL "Cannot find module './cropBox'".
- [ ] **Step 4: Implement `src/lib/cropBox.ts`** with the four exports above.
- [ ] **Step 5: Run it to verify it passes**: same command → PASS (3 tests).
- [ ] **Step 6: Replace the five local `type CropBox = {...}` declarations with `import type { CropBox } from "@/lib/cropBox"`**, and in `PhotoCropZoom.tsx` delete its local `DEFAULT_BOX` / `boxesEqual` in favour of the imports. In `Annotate.tsx` and `Focus.tsx` replace every `left: \`${x.xPct - x.wPct / 2}%\`` style block (Annotate lines ≈938, 1027, 1111; Focus ≈125, 663) with `const r = frameRect(box)` and `left: \`${r.left}%\`, top: \`${r.top}%\`, width: \`${r.width}%\`, height: \`${r.height}%\`` (keep Annotate's `calc(... - TOOLBAR_PAD)` on top/height where present).
- [ ] **Step 7: Verify**: `grep -rn "type CropBox = {" src | wc -l` → `0`; `npm run check` → exit 0.
- [ ] **Step 8: Commit** — `git add vitest.config.ts src/lib/cropBox.ts src/lib/cropBox.test.ts src/components src/pages && git commit -m "One CropBox type and frameRect helper; vitest also runs src/lib tests"`.

### Task 2: `usePhotoUrls` over `photos.urls` (width/height from the server)

**Files:**
- Create: `src/lib/photoUrls.ts`, `src/lib/photoUrls.test.ts`, `src/hooks/use-photo-urls.ts`
- Modify: `src/components/RoomSchema.tsx:25-27, 160-195`, `src/components/ItemPinSchematics.tsx:8-30, 37-60`, `src/components/RoomPhotoPool.tsx:110-120`, `src/components/RoomPhotoCard.tsx:24-33`

**Interfaces:**
- Produces: `export function chunkKeys(keys: ReadonlyArray<string | null | undefined>, size = 200): string[][]` — drops empty/null, dedupes keeping first order, splits into chunks of `size`.
- Produces: `export type PhotoUrlInfo = { id: number | null; key: string; url: string | null; width: number | null; height: number | null }` (the `photos.urls` row); `export function usePhotoUrls(keys: ReadonlyArray<string | null | undefined>): { byKey: ReadonlyMap<string, PhotoUrlInfo>; isLoading: boolean }` built on `trpc.useQueries((t) => chunks.map((c) => t.photos.urls({ keys: c })))`; `export function aspectOf(info: PhotoUrlInfo | undefined): number | null` (= width/height when both > 0).

- [ ] **Step 1: Write the failing test** `src/lib/photoUrls.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { chunkKeys } from "./photoUrls";

describe("chunkKeys", () => {
  it("drops empties, dedupes and keeps order", () => {
    expect(chunkKeys(["a", null, "", "b", "a", undefined])).toEqual([["a", "b"]]);
  });
  it("splits at the server limit of 200", () => {
    const keys = Array.from({ length: 401 }, (_, i) => `k${i}`);
    const chunks = chunkKeys(keys);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 1]);
  });
  it("returns no chunks for no keys", () => {
    expect(chunkKeys([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**: `npx vitest run src/lib/photoUrls.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `chunkKeys` in `src/lib/photoUrls.ts`.**
- [ ] **Step 4: Run to verify it passes** → PASS (3).
- [ ] **Step 5: Implement `src/hooks/use-photo-urls.ts`** with `usePhotoUrls` and `aspectOf` (signatures above). `isLoading` is true while any chunk query is pending.
- [ ] **Step 6: RoomSchema** — call `usePhotoUrls(cards.map((c) => c.storageKey))` once in `RoomSchema`, pass `info={byKey.get(card.storageKey)}` to the card component; in the card replace `trpc.photos.url.useQuery` with `info?.url`, initialise `aspect` from `aspectOf(info)` and keep the `onLoad` fallback only when that is null; delete the module-level `photoAspects` Map (line 25).
- [ ] **Step 7: ItemPinSchematics** — delete `usePhotoAspect` and the `aspects` Map (lines 8-30); after `cards` is built call `usePhotoUrls(cards.map((c) => c.storageKey))` and use `aspectOf(byKey.get(card.storageKey)) ?? 4 / 3` for the `PhotoSchematic` aspect.
- [ ] **Step 8: RoomPhotoPool / RoomPhotoCard** — the pool calls `usePhotoUrls` over its photos' `storageKey`s and passes `url: string | null` to each `RoomPhotoCard`; the card's `trpc.photos.url.useQuery` (line 33) goes.
- [ ] **Step 9: Verify**: `grep -n "photos.url.useQuery" src/components/RoomSchema.tsx src/components/ItemPinSchematics.tsx src/components/RoomPhotoCard.tsx` → no output; `grep -rn "new Image()" src/components` → no output (`src/pages/Annotate.tsx:98` keeps its `new Image()`: that is the crop canvas, not an aspect probe; `Thumb.tsx` and the per-key `photos.url` calls in pages stay — `httpBatchLink` already folds them into one HTTP request); `npm run check` → 0. Open `/rooms/:id?schema=1` and an item page with placements in the dev server (`npm run dev`, port 3000) and confirm the Network tab shows `photos.urls` once per grid.
- [ ] **Step 10: Commit** — `"usePhotoUrls: one photos.urls call per grid, aspect from the server"`.

### Task 3: One capture→Photo promotion: `usePhotoFromTarget`

**Files:**
- Create: `src/hooks/use-photo-from-target.ts`
- Modify: `src/components/AttachPhotoDialog.tsx:12, 50-78`, `src/components/PhotoPlaceDialog.tsx:11-27, 92-100`, `src/components/ChooseFromLibraryDialog.tsx:56-61, 83-86`, `src/components/RecropDialog.tsx:38-46`, `src/components/PhotoCropZoom.tsx:49-58`, `src/pages/Inbox.tsx:175 (PinCaptureButton), 326, 332` (the click handlers at 368/408 call these), `src/pages/Photos.tsx:100, 105, 111`, `src/components/RoomPhotoCard.tsx:36-40`

**Interfaces:**
- Produces: `export type PhotoTarget = { source: "photo"; photoId: number } | { source: "capture"; captureId: number }`; `export function photoTargetKey(t: PhotoTarget): string` (`"p<id>"` / `"c<id>"`, used as React `key`); `export function usePhotoFromTarget(): { resolve: (t: PhotoTarget, roomId?: number | null) => Promise<number>; isPending: boolean }` — `resolve` returns the photo id, calling `photos.ensureForCapture({ captureId, roomId })` only for a capture; `export function invalidatePhotoChange(utils: ReturnType<typeof trpc.useUtils>, opts?: { itemIds?: number[]; photoId?: number }): void` — invalidates `photos.get`, `photos.listAll`, `photos.forRoom`, `photos.roomPhotos`, `photos.listForItem`, `rooms.get`, `inbox.list`, `items.listAll`, `items.placement`, `items.placementSummary`, `items.get` for each `itemIds` entry, `photos.sourcePhoto({ photoId })` when given.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Implement the hook file** with the four exports.
- [ ] **Step 2: AttachPhotoDialog** — `export type AttachTarget = PhotoTarget` (keeps `Photos.tsx:657` compiling); `key={photoTargetKey(target)}`; in `run` replace the `ensure` mutation + `photoId` state with `const id = await resolve(target)`; replace the invalidation block (lines 73-78) with `invalidatePhotoChange(utils, { itemIds: [t.id, ...(fromItemId != null ? [fromItemId] : [])] })`.
- [ ] **Step 3: PhotoPlaceDialog** — the capture variant of `PlaceTarget` becomes `Extract<PhotoTarget, { source: "capture" }>`; `invalidatePhotoPlace` keeps its name and signature (Inbox:1351 calls it) but its body becomes `invalidatePhotoChange(utils)`; the `ensure` mutation becomes `resolve(target, roomId)`.
- [ ] **Step 4: ChooseFromLibraryDialog, RecropDialog, PhotoCropZoom, RoomPhotoCard, Inbox:175/326/332, Photos:100/105/111** — same substitution: `resolve({ source: "capture", captureId }, roomId?)` where `ensureForCapture.mutateAsync` was; `invalidatePhotoChange(utils, …)` where ad-hoc lists were (Recrop/PhotoCropZoom pass `{ photoId }`). Keep every `setLastRoomId(...)` call and every `navigate(\`/annotate/${photoId}?roomId=…\`)` that follows a success today: Annotate still reads `?roomId=` (`confirmedRoomId = photoRoomId ?? roomIdFromUrl`).
- [ ] **Step 5: Verify**: `grep -rn "ensureForCapture.useMutation" src --include=*.tsx | grep -v src/flow` → exactly one hit, in `src/hooks/use-photo-from-target.ts`; `grep -rn "source: \"capture\"; captureId: number }" src | wc -l` → `1`; `npm run check` → 0. In the dev server: Photos → "Attach to Thing" on an inbox image, then "Place" on the same image: the second dialog must reuse the Photo (DB: one `photos` row for that capture).
- [ ] **Step 6: Commit** — `"usePhotoFromTarget: one capture→Photo promotion and one invalidation set"`.

### Task 4: `photos.fileFrame` — frame → Thing + pin (+ cutout) in one call

**Files:**
- Create: `api/lib/fileFrame.ts`, `api/test/photos-fileFrame.test.ts`
- Modify: `api/routers/photos.ts:222-298` (extract body into `api/lib/photos.ts` as `createCutoutFor`), `api/routers/photos.ts` (add `fileFrame`), `src/pages/Annotate.tsx:296-311`, `src/pages/Focus.tsx:244-262`

**Interfaces:**
- Produces (lib): `export async function createCutoutFor(db: Db, input: { itemId: number; sourcePhotoId: number; box: CropBox; photoSize: "small" | "medium" | "big" }): Promise<{ id: number; storageKey: string; created: boolean }>` — the current `createCutout` body, unchanged behaviour (dedupe per capture, `ensurePinForCutout`).
- Produces (lib): `export async function fileFrame(db: Db, ctxHouseId: number | null, input: FileFrameInput): Promise<{ itemId: number; pinId: number; photoId: number | null; createdItem: boolean; createdPhoto: boolean; cutoutError: string | null }>` where `FileFrameInput = { sourcePhotoId: number; box: CropBox; itemId: number | null; itemName?: string; description?: string; areaId?: number; roomId?: number | null; houseId?: number | null; pinId?: number; label?: string; decision?: ItemDecision | null; suggestLinks?: boolean; photoSize?: "small" | "medium" | "big" }`. In one `db.transaction`: create the item exactly like `items.create` does (`description`, `verificationStatus: "confirmed"`, `setItemLocation` when `roomId`, `logEvent created`) when `itemId` is null; set `decision`/`decidedAt` + `decision:<d>` event when `decision` given; when `pinId` is given, update that pin with `{ itemId, label: label ?? name, status: "confirmed" }`, else `ensurePinForCutout(tx, { sourcePhotoId, itemId, box, label: name })`. After the transaction commits, call `createCutoutFor` and report a failure in `cutoutError` instead of throwing (the Thing and pin are already saved, as today). `suggestLinks` defaults to **false** (Focus's current behaviour); when `true`, run the same link-suggestion step `items.create` runs after its transaction (Annotate's current behaviour).
- Produces (router): `photos.fileFrame` with the zod input matching `FileFrameInput` (`box: cropBoxInput`, `decision: z.enum(ITEM_DECISIONS).nullable().optional()`), `.mutation(({ input, ctx }) => fileFrame(getDb(), ctx.houseId, input))`.

- [ ] **Step 1: Extract `createCutoutFor`** from the router into `api/lib/photos.ts`; the router's `createCutout` becomes a one-line call. Run `npx vitest run api/test/photo-sizes.test.ts` → PASS (it exercises cutouts).
- [ ] **Step 2: Write the failing tests** `api/test/photos-fileFrame.test.ts` (seed like `api/test/photo-sizes.test.ts`: house, area, room, a capture with `writeTestJpeg()`, `photos.ensureForCapture` → `sourcePhotoId`; `afterEach(removeTestUploads)`):

```ts
it("(a) makes a Thing, a confirmed pin and a cutout from one frame", async () => {
  const r = await api.photos.fileFrame({ sourcePhotoId, box: { xPct: 50, yPct: 50, wPct: 40, hPct: 40 }, itemId: null, itemName: "Lamp", roomId: keuken });
  expect(r).toMatchObject({ createdItem: true, createdPhoto: true, cutoutError: null });
  const [item] = await db.select().from(items).where(eq(items.id, r.itemId));
  expect(item).toMatchObject({ name: "Lamp", roomId: keuken, houseId: h1, verificationStatus: "confirmed" });
  const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, r.pinId));
  expect(pin).toMatchObject({ photoId: sourcePhotoId, itemId: r.itemId, status: "confirmed" });
  const [cut] = await db.select().from(photos).where(eq(photos.id, r.photoId!));
  expect(cut.cropBox).toEqual({ xPct: 50, yPct: 50, wPct: 40, hPct: 40 });
});
it("(b) links an existing suggested pin to the new Thing instead of adding a pin", async () => {
  const { id: pinId } = await api.pins.add({ photoId: sourcePhotoId, xPct: 20, yPct: 20, wPct: 10, hPct: 10, label: "?" });
  const r = await api.photos.fileFrame({ sourcePhotoId, box: { xPct: 20, yPct: 20, wPct: 10, hPct: 10 }, itemId: null, itemName: "Mug", pinId });
  expect(r.pinId).toBe(pinId);
  expect((await db.select().from(photoPins).where(eq(photoPins.photoId, sourcePhotoId))).length).toBe(1);
});
it("(c) refuses a new Thing without a name", async () => {
  await expect(api.photos.fileFrame({ sourcePhotoId, box, itemId: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
it("(d) stores a decision in the same call", async () => {
  const r = await api.photos.fileFrame({ sourcePhotoId, box, itemId: null, itemName: "Box", decision: "sell" });
  const [item] = await db.select().from(items).where(eq(items.id, r.itemId));
  expect(item.decision).toBe("sell"); expect(item.decidedAt).not.toBeNull();
});
it("(e) a second frame for the same Thing on the same capture reuses the cutout", async () => {
  const r1 = await api.photos.fileFrame({ sourcePhotoId, box, itemId: null, itemName: "Pan" });
  const r2 = await api.photos.fileFrame({ sourcePhotoId, box, itemId: r1.itemId });
  expect(r2).toMatchObject({ createdItem: false, createdPhoto: false, photoId: r1.photoId });
});
```

(Adjust `pins.add`'s exact input to `api/routers/pins.ts:131`; `box` is the (a) box.)

- [ ] **Step 3: Run to verify they fail**: `npx vitest run api/test/photos-fileFrame.test.ts` → FAIL "fileFrame is not a function".
- [ ] **Step 4: Implement `api/lib/fileFrame.ts` and the router procedure.**
- [ ] **Step 5: Run to verify they pass** → PASS (5). Then `npm test` → all green.
- [ ] **Step 6: Focus `admit`** (`src/pages/Focus.tsx`, `admit` — ≈244-262 on `594f63a`, re-read after #22): when `pin` is set, replace `create` + `pinUpdate` + `cutout` + `setDecision` with one `fileFrame.mutateAsync({ sourcePhotoId: photoId, box: boxOf(pin), itemId: null, itemName: trimmed, description: note.trim() || undefined, areaId, roomId: placeHere ? roomId : null, pinId: pin.id, label: trimmed, decision: draftDecision ?? null })` (`suggestLinks` omitted = false, as today); keep the existing `items.create` path when there is no pin, keep `if (placeHere && roomId != null) setLastRoomId(roomId)`, and leave #22's `labelWithClaude` call where it is. Delete the now-unused `cutout` and `pinUpdate` mutations if nothing else uses them.
- [ ] **Step 7: Annotate**: in `savePending` (`createItem.mutateAsync` at ≈line 669, then `ensureItemPhoto` / pin update), call `photos.fileFrame({ sourcePhotoId: attId, box, itemId: null, itemName, areaId, roomId, suggestLinks: true })` instead (Annotate keeps its link suggestions) and invalidate with `invalidatePin(res.pinId, res.itemId)`. Existing-Thing pins (`pins.add` with `onePerThing`) stay as they are.
- [ ] **Step 7b: `AGENTS.md` §2** — add one line after the `photos.*` list: `photos.fileFrame` (input as above; Workbench only; a frame becomes a Thing, a confirmed pin and, best-effort, a cutout; `cutoutError` reports a failed crop without rolling back the Thing).
- [ ] **Step 8: Verify**: `grep -n "createCutout.useMutation" src/pages/Focus.tsx` → none; `npm run check` → 0. In the dev server: Focus → frame → name → Save: one row each in `items`, `photo_pins`, `photos` (cropBox set).
- [ ] **Step 9: Commit** — `"photos.fileFrame: a frame becomes a Thing, pin and cutout in one call; Focus and Annotate use it"`.

### Task 5: One `CropDialog`, `Box` moved to `CropBox.tsx`, `DialogContent size="full"`

**Files:**
- Create: `src/components/CropBox.tsx`, `src/components/CropDialog.tsx`
- Modify: `src/components/DetectObjects.tsx:42-166` (remove `Box`, import it), `src/components/ui/dialog.tsx` (`size` prop), `src/components/RecropDialog.tsx`, `src/components/ChooseFromLibraryDialog.tsx` (step 2 + line ≈90 class), `src/components/PhotoCropZoom.tsx:2-3`

**Interfaces:**
- Produces: `CropBox.tsx` exports `Box` with its current props (`box, color, onChange, onSelect?, selected?, label?, description?, showInlineLabel?`) unchanged, and `DRAG_CLICK_PX`.
- Produces: `CropDialog({ open, title, src, loading, unavailableText, initialBox, color, extra, saving, error, saveLabel, onSave, onClose }: { open: boolean; title: string; src: string | null; loading: boolean; unavailableText: string; initialBox: CropBox; color: string; extra?: ReactNode; saving: boolean; error: string | null; saveLabel: string; onSave: (box: CropBox) => void; onClose: () => void })` — full-screen `Dialog` with the `img + Box` block, Cancel/Save row, error line; owns the `box` state and resets it to `initialBox` when `initialBox` or `open` changes.
- Produces: `DialogContent` accepts `size?: "default" | "full"`; `"full"` applies `w-screen h-[100dvh] max-w-none sm:max-w-none rounded-none p-4 overflow-y-auto`.

- [ ] **Step 1: Move `Box` (and `DRAG_CLICK_PX`) to `src/components/CropBox.tsx`**; update imports in `DetectObjects.tsx`, `RecropDialog.tsx`, `PhotoCropZoom.tsx`, `ChooseFromLibraryDialog.tsx`. `npm run check` → 0.
- [ ] **Step 2: Add `size` to `DialogContent`** and use `size="full"` in `RecropDialog`, `ChooseFromLibraryDialog` and the third site found by `grep -rn 'h-\[100dvh\] max-w-none' src --include='*.tsx'`.
- [ ] **Step 3: Implement `CropDialog`.**
- [ ] **Step 4: `RecropDialog`** becomes: `sourcePhoto` query + `recrop` mutation + `<CropDialog src={source.data?.url ?? null} loading={source.isLoading} unavailableText="This cutout has no linked source photo…" initialBox={source.data?.cropBox ?? { xPct: 50, yPct: 50, wPct: 30, hPct: 30 }} color="#7c3aed" saveLabel="Save crop" saving={recrop.isPending} error={recrop.error?.message ?? null} onSave={(box) => recrop.mutate({ photoId, box })} … />`.
- [ ] **Step 5: `ChooseFromLibraryDialog`** step 2 renders `CropDialog` with `extra={<PhotoSizeSelect …/>}`, `color="#2d4a22"`, `saveLabel="Use this crop"`, `initialBox={DEFAULT_CROP_BOX}`.
- [ ] **Step 6: Verify**: `grep -rn 'h-\[100dvh\] max-w-none' src --include='*.tsx' | grep -v ui/dialog.tsx` → none; `grep -n "^export function Box" src/components/DetectObjects.tsx` → none; `npm run check` → 0. Dev server: Item page → Re-crop, and → Choose from library → crop: both save.
- [ ] **Step 7: Commit** — `"One CropDialog; Box lives in CropBox.tsx; DialogContent size=full"`.

### Task 6: One `PlacePickerDialog`

**Files:**
- Create: `src/components/PlacePickerDialog.tsx`
- Modify: `src/pages/ItemDetail.tsx:1324-1395` (Pick Place), `src/pages/AllItems.tsx:336-351` (Move N Things), `src/pages/Inbox.tsx:392-430` ("Where was this taken?")

**Interfaces:**
- Produces: `PlacePickerDialog({ open, title, description, houseId, roomId, allowNone, confirmLabel, busy, error, onPick, onClose }: { open: boolean; title: string; description?: string; houseId: number | null; roomId: number | null; allowNone?: boolean; confirmLabel: string; busy?: boolean; error?: string | null; onPick: (sel: { houseId: number | null; roomId: number | null }) => void; onClose: () => void })` — `Dialog` + `HouseRoomFields` (`lockToSession` true) + Cancel/confirm row. The caller owns the mutation.
- Consumes: `HouseRoomFields` (`src/components/HouseRoomFields.tsx:9-21`).

- [ ] **Step 1: Implement the component.**
- [ ] **Step 2: ItemDetail** — the Pick Place dialog calls `update.mutate({ id: itemId, roomId, houseId })` from `onPick` (keep its auto-save-on-pick behaviour by calling `onPick` in `HouseRoomFields.onRoom`? No: keep one explicit confirm button, label "Set Place"; the auto-save was the inconsistency).
- [ ] **Step 3: AllItems** — Move N Things: `onPick` → `updateMany.mutate({ ids, roomId, houseId })`, label "Move".
- [ ] **Step 4: Inbox** — "Where was this taken?": `onPick` → `resolve({ source: "capture", captureId }, roomId)` (Task 3) then navigate to `/annotate/:photoId`, label "Continue to pin".
- [ ] **Step 5: Verify**: `grep -n "<RoomPicker" src/pages/ItemDetail.tsx src/pages/AllItems.tsx src/pages/Inbox.tsx` → 0 hits; `npm run check` → 0. Dev server: each of the three flows sets the room (check `items.roomId` / photo room in the UI).
- [ ] **Step 6: Commit** — `"PlacePickerDialog: one dialog to pick a Place in ItemDetail, AllItems and Inbox"`.

# Phase B — Performance

### Task 7: `pins.forItemPhotos` — one query for a Thing's schematics

**Files:**
- Modify: `api/routers/pins.ts` (add after `listForItem`), `src/components/ItemPinSchematics.tsx:37-60`
- Test: `api/test/pins-forItemPhotos.test.ts`

**Interfaces:**
- Produces: `pins.forItemPhotos({ itemId: number })` → the same row shape as `pins.listForRoom` **plus `roomId: number`** (the photo's room), for every pin on every photo that (a) has at least one pin of `itemId` and (b) has a room — photos without a room are skipped, because the card links to `/rooms/:roomId` (today `ItemPinSchematics` drops those pins too). Start from the Thing's pins → their photos → all pins on those photos; do **not** reuse `listForRoom`'s descendant-room walk. Same exclusions: `withPinItems` already drops dismissed pins; drop archived/rejected Things the way `listForRoom` does (reuse that filter; factor it into `api/lib/pins.ts` if it is inline).

- [ ] **Step 1: Write the failing test**: seed a room, two photos in it and one photo with `roomId: null`; pin item A on photo 1 and on the room-less photo, item B on photos 1 and 2; `expect((await api.pins.forItemPhotos({ itemId: A })).map((p) => p.photoId)).toEqual([p1, p1])` (both pins of photo 1, ordered by photoId then id; the room-less photo is absent), every row has `roomId === room`, and `forItemPhotos({ itemId: B })` returns three rows.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS; `npm test` green.**
- [ ] **Step 5: ItemPinSchematics** — replace the `useQueries` over rooms (line 45) with one `trpc.pins.forItemPhotos.useQuery({ itemId })`; build `cards` from that; `roomId` per card comes from the row.
- [ ] **Step 5b: `AGENTS.md` §2** — add `pins.forItemPhotos` to the `pins.*` sentence (Workbench only; rows like `listForRoom` plus `roomId`; room-less photos omitted).
- [ ] **Step 6: Verify**: `grep -n "useQueries" src/components/ItemPinSchematics.tsx` → none; `npm run check` → 0.
- [ ] **Step 7: Commit** — `"pins.forItemPhotos: a Thing's schematics in one query"`.

### Task 8: `RoomPlan3D` — selection without a rebuild

**Files:** Modify `src/components/RoomPlan3D.tsx:208-349`

- [ ] **Step 1:** Remove `selectedCameraId` from the rebuild effect's dependency array (line ≈330) and add a third effect `[selectedCameraId, cameras]` that only updates the camera cones' material (mirror the item-selection effect at lines 333-340; keep refs to cone meshes in a `cameraMeshesRef`).
- [ ] **Step 2: Verify** in the dev server with the console open: add `console.count("rebuild")` temporarily at the top of the rebuild effect, click two camera markers → the count must not increase; remove the log. `npm run check` → 0.
- [ ] **Step 3: Commit** — `"RoomPlan3D: selecting a camera no longer rebuilds the room"`.

### Task 9: `RoomPlan2D` memoised; `placeItemGroup` without DOM queries

**Files:** Modify `src/components/RoomPlan2D.tsx:62, 169-183`

- [ ] **Step 1:** Export `RoomPlan2D` wrapped in `React.memo`; make sure every callback the parents pass (`RoomPlan.tsx`, `ItemRoomPreview.tsx`, `MergeRoomsDialog.tsx`) is `useCallback`-stable or the memo is useless — list the props with `grep -n "onItem\|onCamera\|onPlace\|onCut" src/components/RoomPlan2D.tsx:62-130` and wrap each caller's handler.
- [ ] **Step 2:** Replace the `querySelector` in `placeItemGroup` (169-183) with a `Map<number, SVGGElement>` filled through `ref` callbacks on the item groups.
- [ ] **Step 3: Verify**: React DevTools profiler on `/rooms/:id`: typing in the room name field must not re-render `RoomPlan2D`. `npm run check` → 0.
- [ ] **Step 4: Commit** — `"RoomPlan2D: memoised, item groups by ref"`.

### Task 10: `Model3dViewer` keeps its renderer; `ItemRoomPreview` split

**Files:** Modify `src/components/Model3dViewer.tsx:30-160`, `src/components/ItemRoomPreview.tsx:25-194`

- [ ] **Step 1 (Model3dViewer):** split the effect at line 30 into (a) `[]` — create renderer, scene, controls, resize observer, RAF loop; dispose on unmount — and (b) `[src]` — dispose the previous loaded objects and load the new `src` into the existing scene. Verify: switch a Thing's 3D route twice on the item page; `renderer.info.memory.geometries` (log once, then remove) does not grow.
- [ ] **Step 2 (ItemRoomPreview):** extract `RoomPlanTabs({ room, planItems, cameras, itemId, view, onViewChange, onOpenCamera, full })` (pure: the 2D/3D tab block, lines ≈100-160) and render it both in the card and inside the overlay; the overlay no longer mounts `<ItemRoomPreview size="full">` (line ≈174), so `rooms.get` / `photos.roomPhotos` are subscribed once. Keep the "only one WebGL context" rule (`opened3d && !zoomOpen`).
- [ ] **Step 3: Verify**: `grep -n "<ItemRoomPreview" src/components/ItemRoomPreview.tsx` → none; Network tab: opening the enlarge overlay issues no new `rooms.get`. `npm run check` → 0.
- [ ] **Step 4: Commit** — `"Model3dViewer reuses its renderer; ItemRoomPreview no longer nests itself"`.

# Phase C — Functional gaps

### Task 11: Decide on the Workbench item page

**Files:**
- Create: `src/components/DecisionButtons.tsx`
- Modify: `src/pages/ItemDetail.tsx` (header, next to the Confirm button at line ≈517; mutations at 327-329)

**Interfaces:**
- Produces: `DecisionButtons({ value, onChange, disabled }: { value: ItemDecision | null; onChange: (d: ItemDecision | null) => void; disabled?: boolean })` — five toggles from `DECISIONS` (`src/lib/decisions.ts`), the active one filled with its `color`, clicking the active one clears (`null`). Copy: the labels from `DECISIONS` unchanged.
- Consumes: `trpc.items.setDecision` (`api/routers/items.ts:535`, input `{ id, decision: ItemDecision | null }`).

- [ ] **Step 1:** Implement the component.
- [ ] **Step 2:** In ItemDetail add `const setDecision = trpc.items.setDecision.useMutation({ onSuccess: invalidate })` and render `<DecisionButtons value={it.decision} onChange={(d) => setDecision.mutate({ id: itemId, decision: d })} />` in the header row; show `decidedAt` with `format.ts`'s date helper next to it when set.
- [ ] **Step 3: Verify**: `grep -c "setDecision" src/pages/ItemDetail.tsx` → `≥ 2`; dev server: pick "Sell", reload, it stays; `events` list shows `decision:sell`. `npm run check` → 0.
- [ ] **Step 4: Commit** — `"Item page: Decision buttons"`.

### Task 12: `inbox.create` remembers where the snap was taken

**Files:**
- Modify: `api/routers/inbox.ts:384-412`
- Test: `api/test/inbox-create-room.test.ts`
- Modify: `src/components/CaptureBar.tsx:32` (pass `roomId` from `useLastRoom()` when the Workbench has one)

**Interfaces:**
- `inbox.create` input gains `roomId: z.number().nullable().optional()`. When set and `kind === "image"` with a `storageKey`: after `createCapture` and **before `maybeAutoTriage`** (so triage never runs on an unplaced snap), run the same code `inbox.assignPlace` runs for `{ ids: [row.id], roomId }` — factor `inbox.ts:1061-1100` into `api/lib/captures.ts` `assignCapturePlace(db, ids: number[], sel: { houseId?: number | null; roomId?: number | null }): Promise<{ count: number }>` and call it from both — so the capture's location Photo exists in that room, `captures.houseId` is that room's house ("room wins and sets the house"; `assignPlace` does not read `ctx.houseId` and neither does this), and `inbox.list` rows carry `photoRoomId`. For `note`/`link`/`file`/`scan` kinds `roomId` is ignored (a note has no location Photo; do not rewrite its house or log `placed`). Output unchanged. Flow and iOS send no `roomId` and see no change; they keep their local place until the Flow owner picks up decision A3 (16 Oct).

- [ ] **Step 1: Write the failing tests**:

```ts
it("(a) a snap with a roomId lists with that photoRoomId", async () => {
  const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: keuken });
  const row = (await api.inbox.list()).find((c) => c.id === id)!;
  expect(row.photoRoomId).toBe(keuken);
});
it("(b) an unknown room is refused", async () => {
  await expect(api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: 999999 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Place not found." });
});
it("(c) a room in another house places the snap there and sets the capture's house", async () => {
  const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: roomInHouse2 });
  const [cap] = await db.select().from(captures).where(eq(captures.id, id));
  expect(cap.houseId).toBe(h2);
  expect((await callerFor(h2).inbox.list()).find((c) => c.id === id)!.photoRoomId).toBe(roomInHouse2);
});
it("(d) without roomId nothing changes", async () => {
  const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg() });
  expect((await api.inbox.list()).find((c) => c.id === id)!.photoRoomId ?? null).toBeNull();
});
it("(e) a note ignores roomId", async () => {
  const { id } = await api.inbox.create({ kind: "note", rawText: "buy bulbs", roomId: keuken });
  const [cap] = await db.select().from(captures).where(eq(captures.id, id));
  expect(cap.houseId).toBe(h1);
  expect((await db.select().from(photos).where(eq(photos.sourceCaptureId, id))).length).toBe(0);
});
```

(`api = callerFor(h1)`; seed a second house `h2` with `roomInHouse2`.)

- [ ] **Step 2: Run → FAIL. Step 3: Implement (`assignCapturePlace` extraction first, then the `create` change; keep `assignPlace`'s behaviour byte-for-byte — `npx vitest run api/test/inbox-house.test.ts api/test/inbox-location.test.ts` must stay green). Step 4: Run → PASS; `npm test` green.**
- [ ] **Step 5: CaptureBar** passes `roomId` from `useLastRoom()` (`src/hooks/use-last-room.ts`) only on the image path (`kind: "image"`); the note/link mutations stay as they are.
- [ ] **Step 5b: `AGENTS.md` §2** — in the `inbox.create` mention add "(optional `roomId`, image captures only: places the location Photo and sets the capture's house; Workbench sends it, Flow and iOS keep their local place)".
- [ ] **Step 6: Verify**: `npm run check` → 0; `npm run build` → 0 (server changed).
- [ ] **Step 7: Commit** — `"inbox.create: optional roomId places the snap's Photo at creation"`.

---

## Self-Review

- **Spec coverage:** F1→Task 2, F2→Task 3, F3→Task 4, F4→Tasks 1+5, F5→Task 6, P1→7, P2→8, P3→9, P4+P5→10, G1→11, G2→12. The ConfirmDialog, KindForm/HouseForm and RoomWalls findings from the review are deliberately left out (low value per line changed); the Flow-owned ones are listed as out of scope.
- **Step scan:** every code step names a file, a signature and the values; bodies appear only in tests and in Task 4's transaction rules, which the signature does not determine.
- **Type consistency:** `CropBox` (Task 1) is the type used by `createCutoutFor`, `fileFrame`, `CropDialog`, `Box`; `PhotoTarget`/`resolve` (Task 3) is what Task 6's Inbox step calls; `PhotoUrlInfo` (Task 2) is the `photos.urls` row.
- **Review Focus:** 1→Task 3 step 5 manual check + server find-or-create; 2→Task 4 (c); 3→Task 2 test; 4→Task 4 (e); 5→Task 12 (b)+(c).
- **Check of 2026-11-06 (PR #53):** all nine amendments applied — Task 12 test rewritten to the real `assignPlace` rule and place-before-triage; `description`/`suggestLinks` on `fileFrame`; Inbox:175 in Task 3; `?roomId=`/`setLastRoomId` kept; Task 7 skips room-less photos and the descendant walk; `AGENTS.md` steps 7b/5b/5b; PR sequencing (#22 first, #23 no, #29 beside, #5 close); goal narrowed and `Thumb.tsx` dropped; leftovers listed.
- **Proportion:** 12 tasks, ~330 lines for roughly 1,200 changed lines of code.

## Execution notes for the next agent

- Before Task 1: `git fetch && git worktree add ../declutter-ui-consolidation -b ui-consolidation origin/main && cd ../declutter-ui-consolidation && npm install`, run the Findings table (expect the Focus/pins line numbers to differ from the ones cited: #22 and #54 landed after the plan was written), and re-read `src/pages/Focus.tsx` (`admit`) before Tasks 1 and 4. Run the dev server for manual checks against the test DB: `DATABASE_URL="$TEST_URL" npx vite --port 3002` after `node scripts/seed-test-db.mjs`.
- Order: A (1→6) is sequential (1 before 4 and 5; 3 before 6). B tasks are independent of each other; C tasks are independent. Push after each phase; ask Rick before merging.
- After the branch merges, production needs `npm run build` and `launchctl kickstart -k gui/$(id -u)/nl.homebase.live3001` on the Mini (Rick or a session he allows).
