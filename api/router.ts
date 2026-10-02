import { createRouter, procedure } from "./middleware";
import { areasRouter } from "./routers/areas";
import { itemsRouter } from "./routers/items";
import { inboxRouter } from "./routers/inbox";
import { ideasRouter } from "./routers/ideas";
import { tasksRouter } from "./routers/tasks";
import { attachmentsRouter } from "./routers/attachments";
import { aiRouter } from "./routers/ai";
import { wikiRouter } from "./routers/wiki";
import { eventsRouter } from "./routers/events";
import { settingsRouter } from "./routers/settings";
import { housesRouter } from "./routers/houses";
import { roomsRouter } from "./routers/rooms";
import { measurementsRouter } from "./routers/measurements";
import { photosRouter } from "./routers/photos";
import { pinsRouter } from "./routers/pins";
import { itemLinksRouter } from "./routers/itemLinks";

export const appRouter = createRouter({
  ping: procedure.query(() => ({ ok: true, ts: Date.now() })),
  areas: areasRouter,
  items: itemsRouter,
  inbox: inboxRouter,
  ideas: ideasRouter,
  tasks: tasksRouter,
  attachments: attachmentsRouter,
  ai: aiRouter,
  wiki: wikiRouter,
  events: eventsRouter,
  settings: settingsRouter,
  houses: housesRouter,
  rooms: roomsRouter,
  measurements: measurementsRouter,
  photos: photosRouter,
  pins: pinsRouter,
  itemLinks: itemLinksRouter,
});

export type AppRouter = typeof appRouter;
