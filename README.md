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
| `/items/:id` | Item 360° — attributes, attachments, relations, tasks, history |
| `/annotate/:attachmentId` | Photo pins, AI object detection |
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
- Photos and files are stored on local disk under `uploads/` and served at `/uploads/*`.
- Access: set `APP_TOKEN` in `.env` and the app asks for it once per browser. Without it the
  API and photos are open to anyone who can reach the port, so only run that way on a
  trusted LAN (or behind Tailscale).
- Uploads go through `POST /api/upload` (multipart); the file type is sniffed from content and
  only images, audio, video, PDF, JSON/GeoJSON and 3D scan formats are accepted. Stored files
  are served with `nosniff` and non-media types download instead of rendering.
