# HomeBase

A multi-mode personal inventory OS: capture → inventory → ideas → tasks → wiki,
with LLM assistance woven through every step and a full audit trail.

## Stack

React + TypeScript + Vite + Tailwind/shadcn (frontend) · Hono + tRPC + Drizzle + MySQL (backend) · OpenAI-compatible LLM (optional)

## Quick start

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (and LLM_* if you want AI)
npm run db:push        # create tables
npx tsx db/seed.ts     # optional: seed areas + sample items
npm run dev            # http://localhost:3000 (LAN-accessible)
```

Production-style: `npm run build && npm start`.

## Two front ends, one API

| Front end | URL | Entry | What it is |
|---|---|---|---|
| Workbench | `/` | `index.html` → `src/main.tsx` | Desktop inventory OS: inbox triage, item pages, photos and pins, rooms and plans, galaxy, ideas, tasks, wiki. One shell with a Simple/Advanced toggle. Uses `react-router`. |
| Flow | `/flow/` | `flow/index.html` → `src/flow/main.tsx` | Phone-first loop: Snap → Sort → Act → Gone. Own shell and tab state, no router, no Workbench pages. |

Both are built by one `vite build` (two `rollupOptions.input` entries in `vite.config.ts`) and talk to the same
tRPC API and database. In development `npm run dev` serves both on one port (`/` and `/flow/`). In production
`node dist/boot.js` serves `dist/public/`, and any HTML request under `/flow` that is not a file gets
`dist/public/flow/index.html` (`api/lib/vite.ts`), so Flow deep links never land in the Workbench.
Production runs on port 3001 (`PORT=3001 NODE_ENV=production node dist/boot.js`).

Other clients of the same API: the native iOS app in `ios/` and the Computer Lab adapter
(`/Volumes/T7/computer-lab-ssot`, `server-ssot.js`). AGENTS.md §2 lists the procedures each one depends on.

## Configuration

See `.env.example`. The app works without an LLM configured — AI buttons show a
"not configured" notice and everything else (inventory, tasks, timers, wiki,
photo pins) works normally.

For AI features set any OpenAI-compatible provider via `LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODEL`, `LLM_VISION_MODEL` — e.g. xAI Grok, OpenAI, or a
local Ollama. For Grok you can instead set `XAI_API_KEY` (official xAI env
name); the app uses `https://api.x.ai/v1` and `grok-4.7` for chat and vision.
Or pick **xAI Grok** on the Settings page and paste a console API key. xAI
does not document OAuth for API access.

## Workbench Simple / Advanced (test)

One Workbench, not a second product. A **Simple ↔ Advanced** toggle lives under the house switcher (persisted as `declutter.ui.workbenchMode`). Default is Advanced so the current Workbench is unchanged until you flip it.

- **Simple (Focus):** house (sidebar) → room chips → room photo with numbered frames → unhandled list → thin sheet (name, topic, this Place, decision, short note). Temporary names like “Frame 3” are fine. **Admit** calls `items.create` (name + topic required; room optional) and links the pin; **Save** / **Decision** use `items.update` and `items.setDecision`. Full ItemDetail is still one tap from the sheet.
- **Advanced:** the current Workbench (Galaxy, Wiki, Storage, ItemDetail, …). Focus stays available at `/focus`.

Try it: `npm run dev` → open `/` → switch to **Simple** → pick a room → draw a box on the photo → fill name + topic → Admit. Or click an existing numbered frame. Flow (`/flow/`) is unchanged.

## Modes

| Route | Purpose |
|---|---|
| `/` | Dashboard — stats, quick capture, recent activity (Simple mode sends this to Focus) |
| `/focus` | Room-first Focus: numbered frames on a room photo + thin sheet |
| `/snap` | Phone-first capture (camera → inbox) |
| `/inbox` | Capture triage with AI suggestions |
| `/areas/:slug` | Per-area inventory tables with typed attributes |
| `/flow/` | Flow: phone-first Snap → Sort → Act → Gone (separate front end, see above) |
| `/items/:id` | Item 360° — attributes, photos, links and notes, relations, tasks, history |
| `/photos` | Every photo, grouped by room or topic |
| `/map`, `/rooms` | Redirect to the last or first room of the selected house |
| `/rooms/:id` | Place plan (2D/3D), photo pool and pins |
| `/galaxy` | Bubble view of the inventory by house, floor, room or topic |
| `/annotate/:photoId` | Photo pins, AI object detection |
| `/ideas` | Idea board with AI task breakdown |
| `/tasks` | Kanban with timers and time logs |
| `/wiki` | Auto-generated markdown wiki + LLM context pack export |
| `/activity` | Full audit log |

## Notes for self-hosting

- Database: MySQL 8. The schema lives in `db/schema.ts`; `db/migrations/` holds the
  generated SQL (`npm run db:generate` after a schema change, `npm run db:migrate` to
  apply). An existing database that was created with `db:push` is switched to migrations once with
  `npm run db:adopt 0002_item_decision` (the last tag it already matches); after that, only
  `npm run db:migrate`.
- `node scripts/storage-report-local.mjs --item <id>` measures this machine's boot volume and its top directories and posts them to the Storage page (`/storage`). Other volumes are reported only when named with `--only`; an external drive is reported against its own item, e.g. `node scripts/storage-report-local.mjs --item <drive item id> --only /Volumes/T7`. Each APFS volume is its own row with its own use and data role; volumes of one container (for example `T7` and `TM-T7` on one disk) share its capacity, so `--only /Volumes/T7` reports both. On a Mac the boot container reports two rows: `/` (the sealed system volume; it lists no directories, since its `/Users` and `/Applications` are firmlinks into Data) and `Data` (`/System/Volumes/Data`, your files: `/Users`, `/Applications`, ...). The container's free space is overstated by the VM and Preboot volumes (about 23 GB on the Mac mini), which are not reported because they carry no data role. Add `--dry` to print the report without posting it.
- Photos and files are stored on local disk under `uploads/` and served at `/uploads/*`.
- Access: set `APP_TOKEN` in `.env` and the app asks for it once per browser. Without it the
  API and photos are open to anyone who can reach the port, so only run that way on a
  trusted LAN (or behind Tailscale).
- Uploads go through `POST /api/upload` (multipart); the file type is sniffed from content and
  only images, audio, video, PDF, JSON/GeoJSON and 3D scan formats are accepted. Stored files
  are served with `nosniff` and non-media types download instead of rendering.
