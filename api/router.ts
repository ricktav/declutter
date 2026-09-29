import { createRouter, publicQuery } from "./middleware";
import { areasRouter } from "./routers/areas";
import { itemsRouter } from "./routers/items";
import { inboxRouter } from "./routers/inbox";
import { ideasRouter } from "./routers/ideas";
import { tasksRouter } from "./routers/tasks";
import { attachmentsRouter } from "./routers/attachments";
import { aiRouter } from "./routers/ai";
import { wikiRouter } from "./routers/wiki";
import { eventsRouter } from "./routers/events";
import { annotationsRouter } from "./routers/annotations";
import { settingsRouter } from "./routers/settings";
import { housesRouter } from "./routers/houses";
import { roomsRouter } from "./routers/rooms";
import { measurementsRouter } from "./routers/measurements";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  areas: areasRouter,
  items: itemsRouter,
  inbox: inboxRouter,
  ideas: ideasRouter,
  tasks: tasksRouter,
  attachments: attachmentsRouter,
  ai: aiRouter,
  wiki: wikiRouter,
  events: eventsRouter,
  annotations: annotationsRouter,
  settings: settingsRouter,
  houses: housesRouter,
  rooms: roomsRouter,
  measurements: measurementsRouter,
});

export type AppRouter = typeof appRouter;
