# Review 2026-10-16: decisions and progress

Rick's decisions on `docs/review-2026-10-16.html`, given 2026-10-16. 36 accepted, F1 to discuss, G3 rejected.

## Done (draft PRs, not merged)

| Id | What | PR |
| --- | --- | --- |
| C6 | TRPCError codes for the 17 plain throws; also fixes the `inbox-triage-boxes` test mock that failed on `main` without an LLM key | [#26](https://github.com/ricktav/declutter/pull/26) |
| H1, H2 | `GET /api/health`, `scripts/backup.sh`; a missing `APP_TOKEN` only warns at boot (Rick, 2026-10-17: no token on the trusted LAN) | [#27](https://github.com/ricktav/declutter/pull/27) |
| C5 | AI prompt inventories scoped to the capture's or Photo's house, room first | [#28](https://github.com/ricktav/declutter/pull/28) |
| D4 | `@huggingface/transformers` to devDependencies (script-only) | [#30](https://github.com/ricktav/declutter/pull/30) |
| E7 (Workbench) | Meterkast and parcel-viewer URLs are settings (`settings.links` / `setLinks`), unset links default to the old URLs, an emptied link is off; collector host defaults stay until the launchd plist carries them | [#31](https://github.com/ricktav/declutter/pull/31) |
| A2 | Default topic "Things" on the server: `areaId` optional on `items.create`, `inbox.fileObject`, `inbox.acceptMany` | [#33](https://github.com/ricktav/declutter/pull/33) |
| B1, G2 | Depth (Quick / Standard / Detail) stored on the server; Provider B and A/B at Detail only | [#34](https://github.com/ricktav/declutter/pull/34) |
| (found) | `npm run dev` served a blank Workbench since 2026-10-08: `/api/lib/*.ts` went to the API | [#35](https://github.com/ricktav/declutter/pull/35) |
| D3 | Services collector parsers moved to `scripts/collectors/services/`; host helpers to `api/lib/hostNames.ts` | [#36](https://github.com/ricktav/declutter/pull/36) (Rick: `services-report-all` ok on the Mac mini, 2026-10-17) |
| E2 | One topic icon list (also fixes icons AreaView offered that the sidebar showed as a box), `DECISIONS`, `nameScore`, `StoredImage` | [#37](https://github.com/ricktav/declutter/pull/37) |
| E1 | `hb-*` and `decision-*` colour tokens (CSS variables); 82 Workbench literals replaced, rendering identical | [#38](https://github.com/ricktav/declutter/pull/38) |
| B4 (data half) | Systems and Storage in the sidebar only when the house has machines / drives (`settings.views`); stacked on #34 | [#39](https://github.com/ricktav/declutter/pull/39) |
| C1 | `items.queue` (to sort / check / place / decide, lab role and backup), Focus uses it | [#40](https://github.com/ricktav/declutter/pull/40) |
| G1 | Background triage of new photo snaps (`autoTriage` setting, `triageState` on `inbox.list`, failures visible); stacked on #28 | [#41](https://github.com/ricktav/declutter/pull/41) |
| C2 | `items.search` in MySQL with a limit, prefix first, optional attribute-value match (`fields`) | [#42](https://github.com/ricktav/declutter/pull/42) |
| F3 | Product words in the Workbench copy: Thing, Place, Kind, Sort, snap (code names unchanged) | [#43](https://github.com/ricktav/declutter/pull/43) |


After merging: #41 does nothing until "Triage new photos automatically" is switched on.

Merge order that avoids conflicts: #35 first (dev server), then #26, #28 → #41, #34 → #39, and the rest in any order. #37, #38 and #43 touch the same Workbench files at neighbouring lines (text-only conflicts).

## F1: does deriving cutouts slow down catalog views?

Only on a cold first view, and only if the cache is not warmed. Listing queries do not change: rows and `storageKey`s are the same. The cost is in the image bytes: rendering a crop from a full photo with sharp (decode, crop, resize) takes roughly 50–200 ms per tile on the Mac mini, so a grid of 60 never-seen cutouts would take a few seconds to fill once. After that each crop is a file on disk, served like today.

To keep viewing speed equal to today: render the crop into the cache when the cutout is created (`photos.createCutout`, `inbox.fileObject`, `inbox.acceptMany`), so the first view hits a file too. What F1 then still buys: a cutout is a row plus a box, re-cropping never orphans a file, and the dedup scripts stop being needed. Proposed condition for accepting: "derived, cache warmed on create, cache rebuildable from the rows".

## G3 rejected

`claude -p` (`AI_DEV_PROVIDER=claude-cli`) stays available, also in production, for Claude subscription users. C4 (one detect and one cutout function) keeps the CLI path working in its single new home.

## Next, in order

Step 1, no schema change, no contract break:

1. E2 shared constants (`DECISIONS`, `AREA_ICONS`, `nameScore`) and E1 design tokens (124 colour literals). Touches `src/flow/` constants: Flow owner sign-off for the Flow side, or Workbench only first.
2. E7 no LAN addresses or item ids in source (`METERKAST_URL` in `Layout.tsx`, and a copy in Flow-owned `src/flow/EnergyParts.tsx`; collector defaults to env).
3. D4 move `@huggingface/transformers` to devDependencies (script-only).
4. D3 move collector parsers (`api/lib/services*.ts`, about 5,200 lines) next to their scripts.
5. G2 Provider B and A/B compare behind Detail depth.
6. A2 default topic on the server (`settings.defaultAreaId`, used when `areaId` is omitted). Adds an optional input; AGENTS.md §2 gets a line.
7. B1 depth stored on the server (settings, `ui.depth`), Workbench reads it; B4 sidebar diet; F3 product words in UI copy.

Step 2, shared pieces: C1 `items.queue` (with tests, then Workbench Today and Focus use it; Flow and iOS adopt it at their pace) → B2 Today → B6 thin sheet → B5 Thing page sections → D1 module switches → G1 background triage → C4 one detect and cutout → E3 file splits → E6 preferences module → A1 first run → A4 one-command setup.

Step 3, needs the Flow owner or another client first:

- A3 Snap Place on the server: `inbox.create` takes an optional `roomId` (additive); Flow and iOS then stop storing it locally.
- B3 one Sort surface, D2 lens registry, B7 phone-width shell: touch `src/flow/`.
- D5 retire `attachments.*`: the Computer Lab adapter (`/Volumes/T7/computer-lab`) still falls back to `attachments.listAllImages`; switch it first, then remove the aliases and update AGENTS.md §2.
- F2 foreign keys: orphan report first (`scripts/db-orphans.mjs`, read-only), then a migration on `declutter_test`, the full suite, a backup, then live. AGENTS.md §3 treats this as yours to apply.
- C2, C3, C7, E4, E5: independent; any session.

## Status after the second session (2026-10-16)

Step 1 is done (all in draft PRs above); B4's module-switch half waits on D1. From step 2, C1, C2 and G1 are done. Still open, in order: B2 Today (needs #40), B6 thin sheet, B5 Thing page sections, D1 module switches, C4 one detect and cutout (keeps `claude -p`), E3 file splits, E6 preferences, A1 first run, A4 one-command setup. B2, B6, B5 and E3 rework the files that #37, #38 and #43 touch, so they are easier after those merge.
