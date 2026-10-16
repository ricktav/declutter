# Review 2026-10-16: decisions and progress

Rick's decisions on `docs/review-2026-10-16.html`, given 2026-10-16. 36 accepted, F1 to discuss, G3 rejected.

## Done (draft PRs, not merged)

| Id | What | PR |
| --- | --- | --- |
| C6 | TRPCError codes for the 17 plain throws; also fixes the `inbox-triage-boxes` test mock that failed on `main` without an LLM key | [#26](https://github.com/ricktav/declutter/pull/26) |
| H1, H2 | Production exits without `APP_TOKEN` (or explicit `ALLOW_OPEN_ACCESS=1`), `GET /api/health`, `scripts/backup.sh` | [#27](https://github.com/ricktav/declutter/pull/27) |
| C5 | AI prompt inventories scoped to the capture's or Photo's house, room first | [#28](https://github.com/ricktav/declutter/pull/28) |

Before #27 is deployed: check that production's `.env` has `APP_TOKEN`, or the next boot stops with an explanation.

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
