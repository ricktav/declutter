---
cursor:
  subagentId: "bc-25033261-bf0e-53c9-b5d3-25b99ed84ac3"
---

# Consolidation plan check — 6 Nov 2026

**Partly agree.**

The plan to follow is `docs/superpowers/plans/2026-11-06-ui-consolidation.md` on `origin/main` at `2ac71b8` (Rick, 6 Nov 2026 20:15 +0100, “Plan: UI consolidation from the 2026-11-06 modal/viewer review”). It is the only consolidation plan added or updated that day. Heading: “UI Consolidation Implementation Plan”. Its code baseline is `594f63a` (iOS signing team in the Xcode project). That commit does not touch the Workbench, so the plan’s line cites were checked on `2ac71b8`.

Skipped, both already executed:

- `docs/superpowers/plans/2026-10-02-photos-consolidation.md` (rollout notes 3 Oct, `bed299c`)
- `docs/superpowers/plans/2026-10-02-rooms-consolidation.md` (2 Oct)

Compared with `docs/repo-review.md` (`main` at `d8d57f7`, 5 Oct) and `docs/pr-audit.md` (open PRs on 6 Nov, `main` then `2aca157`). No code was changed. Open pull requests were listed again: #29, #23, #22, and #5 are still open on the same heads the audit named. #18 and #19 are still not open.

## What the plan gets right

The findings table still matches the tree. Phase A before B and C is the right order: shared `CropBox` before the dialog and `fileFrame`, and `usePhotoFromTarget` before the Inbox place dialog calls it. The global constraints match `AGENTS.md`: no `src/flow/` edits, no schema change, new procedures and optional inputs only, tests on `declutter_test`, no new dependencies.

Checked on `origin/main`:

| Claim | On `2ac71b8` |
|---|---|
| No Workbench caller of `photos.urls`; aspect probe via `new Image()` in `ItemPinSchematics.tsx` | Yes. `photos.urls` is absent under `src/`. The probe is lines 10–16. |
| `createCutout.useMutation` once in Annotate and once in Focus | Annotate line 297, Focus line 234. |
| Five local `type CropBox` declarations | Those five files, no others. |
| `RoomPicker` in ItemDetail, AllItems, and Inbox | Lines 1332, 341, and 400. Nowhere else in those files. |
| `ItemPinSchematics` `useQueries` | Line 45. |
| `selectedCameraId` in the RoomPlan3D rebuild deps | Line 330. |
| `RoomPlan2D` not memoised | No `memo(`. |
| `Model3dViewer` effect deps `[src]` | Line 160. |
| `ItemRoomPreview` renders itself | Line 174. |
| Item page never calls `setDecision` | Zero hits. `items.setDecision` is still `api/routers/items.ts:535`. `DECISIONS` is in `src/lib/decisions.ts`. |
| `inbox.create` takes no `roomId` | Input is `api/routers/inbox.ts:384–412`. |
| Three full-screen crop dialogs | `ChooseFromLibraryDialog.tsx:97`, `DetectObjects.tsx:327`, `RecropDialog.tsx:52`. Task 5’s “third site” grep finds DetectObjects. |
| `HouseRoomFields` exists | `src/components/HouseRoomFields.tsx`. |
| `photos.urls` rejects more than 200 combined | The refine is on the procedure. Client chunking is the right fix. |
| Cutout dedupe is per item and source capture | `createCutout` returns the existing row with `created: false`. Task 4 test (e) matches that. |
| Focus already opts out of link suggestions | `suggestLinks: false` in `admit`. |

Task 11 is the right fix for a gap that is still open: the Workbench item page still has no Decision control, and `items.setDecision` already accepts the five decisions or `null`. Buttons that call it, without a new status, match the product rule that “Gone” is archived plus a decision.

The performance tasks match the code they name. `pins.forItemPhotos` returning every pin on a photo that contains the Thing matches what `ItemPinSchematics` already draws (this Thing outlined, the others dimmed). `withPinItems` already drops dismissed pins, and `listForRoom` then drops archived and rejected Things, so “same exclusions” is a real function to reuse. `listForRoom` does not put the photo’s `roomId` on the row; the plan is right that the new row needs it.

Leaving Flow, `attachments.url`, and pin-to-plan linking out of this plan is right. `fileFrame` keeping the cutout outside the transaction, and reporting `cutoutError` instead of rolling back the Thing and the pin, is how Focus works today (the pin is saved, the cutout is allowed to fail).

## Where it differs from the 5 Oct review

The review’s “what to do next” is not this plan, and it should not be replaced by it. Two of its risks are already closed or still sitting beside this work.

**Already fixed, so the plan is right to ignore it.** The review said `src/lib/geojsonFloor.ts` and `api/lib/geojsonFloor.ts` had drifted, and that both still cited `scripts/import-geojson-floor.mjs`. The client file now calls `parseGeojsonFloor` from the API module. The import-script comment is gone. Do not add that work back.

**Still true, and still outside this plan.** Draft PR #5 should be closed. The README route table still lists `/snap`. `package.json` is still `my-app` at `0.0.0`. There is still no `.github/` workflow, so `npm run check` and `npm test` still run only when someone remembers. This plan does not make those worse. It also does not mention them. An agent that treats the plan as the whole backlog will skip them.

**The decision gap.** The review said to show the decision on the item page if its absence gets in the way. Task 11 does that, as toggles rather than a badge. Agree with the plan. The review’s wording was the weaker one.

**“Leave the location model alone” is stale.** That line was written the day after rooms-as-location landed. Since then the tree has `photos.setRoom`, `inbox.assignPlace` (“room wins and sets the house”), and a last-room memory. Task 12 is the server half of the 16 Oct decision A3: optional `roomId` on `inbox.create`, Workbench only, Flow and iOS unchanged. That split is right. The plan’s test for it is not (next section).

## Where it differs from the 6 Nov PR audit

The plan never mentions the four open pull requests. They are still open, and two of them edit the same files Phase A and Task 7 edit.

- **#22** (`cursor/focus-claude-frame-label-0cb1`, `0130f4e`) is still the one to rebase and merge. It adds `pins.labelWithClaude` and a dozen hunks in `src/pages/Focus.tsx`, including the sheet around today’s `admit` (create at line 230, cutout at 234). The audit’s verdict stands: not on main, conflicts are Focus and one `AGENTS.md` line, `labelCropWithClaude` on main is the batch detector. Phase A rewrites `CropBox` in Focus and replaces `admit`’s three mutations with `photos.fileFrame`. Landing the plan first makes #22’s rebase worse. Landing #22 first moves every Focus line the plan cites, and adds a fourth call the “three mutations” sentence does not know about. `claude -p` stays; the 16 Oct note rejected removing it.
- **#23** is still do-not-merge. House scope is on main via #28. The branch also has a Focus hunk that passes `houseId` into `detect.mutate`. Do not absorb that hunk. The leftover worth keeping is still `normalizeDetectBox` and `forDetectVision`, ported onto the current procedures. This plan also edits `api/routers/pins.ts` and `api/routers/inbox.ts`, so that port conflicts more if it waits until after `fileFrame` and `inbox.create`’s new input.
- **#29** does not touch these files. It stays “mergeable after rebase” and can land beside this plan.
- **#5** is still the 4 Oct app. Close it. The plan does not touch `ios/` sources. `594f63a` only sets the signing team, which makes #5 staler, not more mergeable.
- **#18 and #19** stay merged. Nothing in the plan reopens them.

## What I would change in the plan

1. **Task 12 test (b) is wrong, and it contradicts the task text.** `inbox.assignPlace` (`api/routers/inbox.ts:1061`) does not refuse a room in another house than `x-house-id`. It does not read `ctx`. An unknown room is `BAD_REQUEST` “Place not found.” A known room sets `captures.houseId` from the room. The location photo is item-less, so `setPhotoRoom` allows it (`api/lib/photos.ts` only refuses when the photo’s Thing is in another house). `AGENTS.md` says room wins and sets the house. Test (b) expects `BAD_REQUEST` for `roomInHouse2`. The prose says to run the same code as `assignPlace`. Those two instructions cannot both be implemented. Change the test to: unknown room is refused; a room in another house places the snap and sets the house. Do not add a session-house lock on `create` only.

2. **Stamp the place before `maybeAutoTriage`.** `inbox.create` already calls `maybeAutoTriage`, which enqueues triage. The plan never mentions that call. If `assignPlace` runs after the enqueue, triage can run on an unplaced snap. Put the place update first, then triage. On `CaptureBar`, pass `roomId` only for an image. The text and link mutates should stay as they are. A note has no location photo; `assignPlace` would still rewrite the capture’s house and log `placed`.

3. **`fileFrame` drops Focus’s note, and it changes Annotate’s suggestions.** Focus `admit` stores `description` from the note field. `FileFrameInput` has no description, and Task 4 step 6 does not pass it. Add `description`. Annotate’s `savePending` (`Annotate.tsx` around line 669) calls `items.create` without `suggestLinks`, so it gets the Workbench default (name suggestions and the LLM). The plan forces `suggestLinks` false for every `fileFrame`. That matches Focus and changes Annotate. Keep each caller’s current flag, or write the Annotate change down as intentional. Keep the `setLastRoomId` line that follows a successful place in `admit`.

4. **Task 3 under-counts the Inbox.** There are 10 `ensureForCapture.useMutation` sites in 6 files, not 9. Inbox has three: `PinCaptureButton` at line 175, plus the two at 326 and 332. The task cites Inbox lines 368 and 408 only, which are the click handlers in the place dialog. The “exactly one mutation left, in the hook” check would catch `PinCaptureButton`, but the file list should name it. Task 6’s navigate to `/annotate/:photoId` can drop `?roomId=` only after `resolve` has written the photo’s room. Annotate still reads that query (`confirmedRoomId = photoRoomId ?? roomIdFromUrl`). Also keep `setLastRoomId` in that Inbox success path.

5. **Task 7 should not invent cards for a photo with no room.** Today `ItemPinSchematics` drops pins whose `roomId` is null, then links to `/rooms/${roomId}`. `forItemPhotos` as written returns every pin on every photo that contains the Thing, including a room-less photo. Skip those, or the new card has nowhere to open. `listForRoom` also walks rooms cut from the requested room; the new query does not need that walk if it starts from the Thing’s pins. Say so, so nobody re-implements the descendant walk and then filters it away.

6. **Write the new contract lines into `AGENTS.md` §2.** The plan adds `photos.fileFrame`, `pins.forItemPhotos`, and an optional `roomId` on `inbox.create`, and never edits `AGENTS.md`. Callers are allowed to ignore an optional field. The contract list is how the next session, Flow, and iOS learn it exists. State that Flow and iOS keep their local place until the Flow owner picks up A3.

7. **Sequence the open pull requests in the execution notes.** Rebase and merge #22 first, then re-run the findings greps and re-read Focus before Task 1 and Task 4. `labelWithClaude` stays a draw-time naming step; do not fold it into `fileFrame` and do not delete it while replacing `admit`. Do not merge #23. Port `normalizeDetectBox` and `forDetectVision` as their own change, before or after this plan, not by taking that branch. Leave #29 and “close #5” as the audit left them.

8. **Narrow the opening goal.** “One photo-URL resolver” is wider than Task 2. After Task 2, `photos.url.useQuery` remains in Thumb, Focus, Inbox, ItemDetail, Photos, RoomPlan, DetectObjects, and others. `Thumb.tsx` is in the file-structure modify list and in no task. Either drop it from that list or add the step. `Annotate.tsx` also has `new Image()`, for the crop canvas, not for aspect. The components-only grep is the right check; do not delete that canvas.

9. **One out-of-scope sentence.** Point at the review leftovers that are still open and not part of these 12 tasks: close #5, fix the README `/snap` row, and add a workflow that runs `npm run check` and `npm test`. Do not put them in Phase A.
