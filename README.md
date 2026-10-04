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
| Workbench | `/` | `index.html` → `src/main.tsx` | Desktop inventory OS: inbox triage, item pages, photos and pins, rooms and plans, galaxy, ideas, tasks, wiki. Uses `react-router`. |
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
local Ollama.

## Modes

| Route | Purpose |
|---|---|
| `/` | Dashboard — stats, quick capture, recent activity |
| `/snap` | Phone-first capture (camera → inbox) |
| `/inbox` | Capture triage with AI suggestions |
| `/areas/:slug` | Per-area inventory tables with typed attributes |
| `/flow/` | Flow: phone-first Snap → Sort → Act → Gone (separate front end, see above) |
| `/items/:id` | Item 360° — attributes, photos, links and notes, relations, tasks, history |
| `/photos` | Every photo, grouped by room or topic |
| `/map` | A room's photo pool and pins |
| `/rooms` | Rooms of the current house; scanned rooms open their plan |
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
- `node scripts/storage-report-local.mjs --item <id>` measures this machine's boot volume and its top directories and posts them to the Storage page (`/storage`). Other volumes are reported only when named with `--only`; an external drive is reported against its own item, e.g. `node scripts/storage-report-local.mjs --item <drive item id> --only /Volumes/T7`.
- Photos and files are stored on local disk under `uploads/` and served at `/uploads/*`.
- Access: set `APP_TOKEN` in `.env` and the app asks for it once per browser. Without it the
  API and photos are open to anyone who can reach the port, so only run that way on a
  trusted LAN (or behind Tailscale).
- Uploads go through `POST /api/upload` (multipart); the file type is sniffed from content and
  only images, audio, video, PDF, JSON/GeoJSON and 3D scan formats are accepted. Stored files
  are served with `nosniff` and non-media types download instead of rendering.
