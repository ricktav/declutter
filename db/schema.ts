import {
  mysqlTable,
  serial,
  bigint,
  varchar,
  text,
  json,
  timestamp,
  index,
  double,
  boolean,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ---------------------------------------------------------------------------
// Areas — top-level categories (computers, garage, kitchen, ...)
// attributeDefs: [{ key, label, type: "text"|"number"|"select", options? }]
// ---------------------------------------------------------------------------
export const areas = mysqlTable("areas", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  icon: varchar("icon", { length: 64 }).notNull().default("box"),
  color: varchar("color", { length: 32 }).notNull().default("#6366f1"),
  description: text("description"),
  attributeDefs: json("attributeDefs").$type<AttributeDef[]>(),
  sortOrder: bigint("sortOrder", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export interface AttributeDef {
  key: string;
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
}

// ---------------------------------------------------------------------------
// Items — things inside an area. attributes = free-form key/value map.
// ---------------------------------------------------------------------------
export const houses = mysqlTable("houses", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  address: text("address"),
  lat: double("lat"),
  lng: double("lng"),
  notes: text("notes"),
  // from PDOK BAG/BRK lookup when the address was picked via the PDOK
  // autocomplete, used to link out to the kadastrale-kaart viewer and show
  // parcel size
  bagId: varchar("bagId", { length: 32 }),
  parcelId: varchar("parcelId", { length: 64 }),
  parcelAreaM2: double("parcelAreaM2"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const items = mysqlTable(
  "items",
  {
    id: serial("id").primaryKey(),
    areaId: bigint("areaId", { mode: "number", unsigned: true }).notNull(),
    houseId: bigint("houseId", { mode: "number", unsigned: true }),
    roomId: bigint("roomId", { mode: "number", unsigned: true }),
    parentId: bigint("parentId", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).$type<"active" | "archived">().notNull().default("active"),
    verificationStatus: varchar("verificationStatus", { length: 32 })
      .$type<"detected" | "confirmed" | "rejected">()
      .notNull()
      .default("confirmed"),
    attributes: json("attributes").$type<Record<string, string | number>>(),
    pos: json("pos").$type<ItemPos>(),
    // what happens to the thing - null until someone decides; "later"
    // parks it for another pass instead of forcing an answer now
    decision: varchar("decision", { length: 16 }).$type<ItemDecision>(),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
    archivedAt: timestamp("archivedAt"),
  },
  (t) => [
    index("items_area_idx").on(t.areaId),
    index("items_house_idx").on(t.houseId),
    index("items_room_idx").on(t.roomId),
  ],
);

export const ITEM_DECISIONS = ["keep", "sell", "donate", "toss", "later"] as const;
export type ItemDecision = (typeof ITEM_DECISIONS)[number];

// Footprint on a room's 2D/3D plan — absent until the item is placed.
export interface ItemPos {
  xM: number;
  yM: number;
  wM: number;
  dM: number;
  rotDeg: number;
  baseM?: number; // height of the surface it's stacked on; 0 = floor
  hM?: number; // the item's own height - used for 3D and as a stacking host's donor height
}

// ---------------------------------------------------------------------------
// Rooms — canonical geometry for a scanned/mapped space, house_id-scoped.
// walls/openings hold the raw provider geometry (GeoJSON-shaped for MappedIn).
// ---------------------------------------------------------------------------
export const rooms = mysqlTable(
  "rooms",
  {
    id: serial("id").primaryKey(),
    houseId: bigint("houseId", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    // the room's floor. A property of the room, set once; views filter or
    // group by it, pickers never ask for it as a step (product rule 1)
    floor: varchar("floor", { length: 32 }),
    source: varchar("source", { length: 64 }).$type<"mappedin" | "roomplan" | "manual">().notNull(),
    scanDate: timestamp("scanDate"),
    widthM: double("widthM"),
    depthM: double("depthM"),
    wallHeightM: double("wallHeightM"),
    walls: json("walls").$type<RoomGeometry["walls"]>(),
    openings: json("openings").$type<RoomGeometry["openings"]>(),
    lat: double("lat"), // override for a room scanned as its own structure (shed, garage)
    lng: double("lng"),
    // Set only on a room cut out of another (cutFromRoom) - the source room's
    // own geometry is never touched, so rolling the cut's items back up into
    // the parent's overview is purely additive: add this offset to a child
    // item's local pos to show it in the parent's frame, subtract it to
    // write back. parentRoomId null = a root scan (LiDAR/MappedIn import),
    // where deleting the room has nowhere to send its items back to.
    parentRoomId: bigint("parentRoomId", { mode: "number", unsigned: true }),
    offsetXM: double("offsetXM"),
    offsetYM: double("offsetYM"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    index("rooms_house_idx").on(t.houseId),
    index("rooms_parent_idx").on(t.parentRoomId),
    // one room per name per house; MySQL's default utf8mb4 collation is
    // case-insensitive, so "Keuken" and "keuken" collide, as intended
    uniqueIndex("rooms_house_name_uq").on(t.houseId, t.name),
  ],
);

export interface RoomGeometry {
  // kind defaults to "wall" when absent (the original single-room seed data
  // predates this field) - door/window segments can land anywhere on a real
  // multi-room floor plan, which the edge-based `openings` below can't
  // express, so they're carried as kinded wall segments instead.
  walls: Array<{ points: [number, number][]; kind?: "wall" | "door" | "window" }>;
  openings: Array<{ edge: string; offsetM: number; widthM: number; connectsTo?: number }>;
}

// Percent-of-original-image box, same shape used for detected object frames.
export interface CropBox {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

// ---------------------------------------------------------------------------
// Photos — images only (replaces attachments with kind "image"). An item's
// photo has itemId; a location photo has roomId and no itemId; a cutout
// carries the capture it was cropped from (sourceCaptureId) and the box.
// ---------------------------------------------------------------------------
export const photos = mysqlTable(
  "photos",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    roomId: bigint("roomId", { mode: "number", unsigned: true }),
    title: varchar("title", { length: 255 }),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    sourceCaptureId: bigint("sourceCaptureId", { mode: "number", unsigned: true }),
    cropBox: json("cropBox").$type<CropBox | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("photos_item_idx").on(t.itemId),
    index("photos_room_idx").on(t.roomId),
    index("photos_source_capture_idx").on(t.sourceCaptureId),
  ],
);

// ---------------------------------------------------------------------------
// Item links — a link, a note or a non-image file on an item (replaces
// attachments with kind "link" | "note" | "file"). sourceCaptureId marks the
// inbox capture it was filed from, so inbox.mergeDuplicates never deletes it.
// ---------------------------------------------------------------------------
export const itemLinks = mysqlTable(
  "item_links",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    kind: varchar("kind", { length: 32 }).$type<"link" | "note" | "file">().notNull(),
    title: varchar("title", { length: 255 }),
    content: text("content"),
    url: text("url"),
    storageKey: varchar("storageKey", { length: 512 }),
    mimeType: varchar("mimeType", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    sourceCaptureId: bigint("sourceCaptureId", { mode: "number", unsigned: true }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("item_links_item_idx").on(t.itemId),
    index("item_links_source_capture_idx").on(t.sourceCaptureId),
  ],
);

// ---------------------------------------------------------------------------
// Photo pins — pins on a photo, optionally linked to an item (replaces
// photo_annotations; attachmentId is now photoId).
// ---------------------------------------------------------------------------
export const photoPins = mysqlTable(
  "photo_pins",
  {
    id: serial("id").primaryKey(),
    photoId: bigint("photoId", { mode: "number", unsigned: true }).notNull(),
    xPct: double("xPct").notNull(),
    yPct: double("yPct").notNull(),
    wPct: double("wPct"),
    hPct: double("hPct"),
    label: varchar("label", { length: 255 }).notNull().default(""),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    origin: varchar("origin", { length: 32 }).$type<"user" | "ai">().notNull().default("user"),
    status: varchar("status", { length: 32 }).$type<"suggested" | "confirmed">().notNull().default("confirmed"),
    // "needs attention", independent of confirm status - the Map view's focus marker
    flagged: boolean("flagged").notNull().default(false),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("photo_pins_photo_idx").on(t.photoId), index("photo_pins_item_idx").on(t.itemId)],
);

// ---------------------------------------------------------------------------
// Measurements — human-validated dimensions (laser/tape) against a room edge
// or an item footprint; a second data point, never a silent overwrite.
// ---------------------------------------------------------------------------
export const measurements = mysqlTable(
  "measurements",
  {
    id: serial("id").primaryKey(),
    targetType: varchar("targetType", { length: 16 }).$type<"room" | "item">().notNull(),
    targetId: bigint("targetId", { mode: "number", unsigned: true }).notNull(),
    field: varchar("field", { length: 64 }), // e.g. "width", "depth", "wall:right"
    valueM: double("valueM").notNull(),
    method: varchar("method", { length: 32 }).$type<"laser" | "tape" | "scan">().notNull(),
    note: text("note"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("meas_target_idx").on(t.targetType, t.targetId)],
);

// ---------------------------------------------------------------------------
// Inbox captures — frictionless drop zone, triaged (optionally by AI) later
// ---------------------------------------------------------------------------
export const captures = mysqlTable(
  "captures",
  {
    id: serial("id").primaryKey(),
    kind: varchar("kind", { length: 32 })
      .$type<"note" | "link" | "image" | "file" | "scan" | "voice">()
      .notNull()
      .default("note"),
    rawText: text("rawText"),
    url: text("url"),
    storageKey: varchar("storageKey", { length: 512 }),
    // sha256 of the file's bytes - lets an image/file capture be deduped
    // against one already in the inbox (a re-sent Telegram photo, the same
    // file uploaded twice) without comparing content on every insert
    contentHash: varchar("contentHash", { length: 64 }),
    exifGps: json("exifGps").$type<{ lat: number; lng: number } | null>(),
    status: varchar("status", { length: 32 }).$type<"pending" | "triaged" | "dismissed" | "processed">().notNull().default("pending"),
    suggestion: json("suggestion").$type<TriageSuggestion>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("captures_hash_idx").on(t.contentHash)],
);

export interface TriageSpottedItem {
  itemName: string;
  areaSlug: string;
  matchedItemId?: number | null;
  matchedItemName?: string | null;
  isNewItem: boolean;
  attributes?: Record<string, string>;
  confidence: "high" | "medium" | "low";
}

export interface TriageSuggestion {
  /** one-line overview of the scene, not tied to any single spotted item */
  note?: string;
  floor?: string | null;
  room?: string | null;
  roomId?: number | null; // resolved from `room` text within the session's house; null = no such room yet
  items: TriageSpottedItem[];
}

// ---------------------------------------------------------------------------
// Ideas — collected topics per area/item, promotable to tasks
// ---------------------------------------------------------------------------
export const ideas = mysqlTable(
  "ideas",
  {
    id: serial("id").primaryKey(),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    status: varchar("status", { length: 32 }).$type<"new" | "exploring" | "converted" | "archived">()
      .notNull()
      .default("new"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [index("ideas_area_idx").on(t.areaId)],
);

export const ideaItems = mysqlTable("idea_items", {
  id: serial("id").primaryKey(),
  ideaId: bigint("ideaId", { mode: "number", unsigned: true }).notNull(),
  itemId: bigint("itemId", { mode: "number", unsigned: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Tasks + time logs
// ---------------------------------------------------------------------------
export const tasks = mysqlTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    ideaId: bigint("ideaId", { mode: "number", unsigned: true }),
    title: varchar("title", { length: 255 }).notNull(),
    notes: text("notes"),
    status: varchar("status", { length: 32 }).$type<"todo" | "doing" | "done">().notNull().default("todo"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
  },
  (t) => [index("tasks_status_idx").on(t.status)],
);

export const timeLogs = mysqlTable("time_logs", {
  id: serial("id").primaryKey(),
  taskId: bigint("taskId", { mode: "number", unsigned: true }).notNull(),
  startedAt: timestamp("startedAt").notNull(),
  endedAt: timestamp("endedAt"),
  seconds: bigint("seconds", { mode: "number" }).notNull().default(0),
  note: varchar("note", { length: 255 }),
});

// ---------------------------------------------------------------------------
// Relations — typed links between items; AI may suggest, user confirms
// ---------------------------------------------------------------------------
export const relations = mysqlTable(
  "relations",
  {
    id: serial("id").primaryKey(),
    fromItemId: bigint("fromItemId", { mode: "number", unsigned: true }).notNull(),
    toItemId: bigint("toItemId", { mode: "number", unsigned: true }).notNull(),
    type: varchar("type", { length: 64 }).notNull().default("related-to"),
    origin: varchar("origin", { length: 32 }).$type<"user" | "ai">().notNull().default("user"),
    status: varchar("status", { length: 32 }).$type<"suggested" | "confirmed">().notNull().default("confirmed"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("rel_from_idx").on(t.fromItemId), index("rel_to_idx").on(t.toItemId)],
);

// ---------------------------------------------------------------------------
// Events — append-only audit log of everything that happens
// ---------------------------------------------------------------------------
export const events = mysqlTable(
  "events",
  {
    id: serial("id").primaryKey(),
    entityType: varchar("entityType", { length: 32 }).notNull(),
    entityId: bigint("entityId", { mode: "number" }),
    action: varchar("action", { length: 64 }).notNull(),
    summary: varchar("summary", { length: 512 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>(),
    actor: varchar("actor", { length: 32 }).$type<"user" | "ai" | "system">().notNull().default("user"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("events_created_idx").on(t.createdAt), index("events_entity_idx").on(t.entityType, t.entityId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Wiki pages — generated markdown per area/item, regenerable on demand
// ---------------------------------------------------------------------------
export const wikiPages = mysqlTable("wiki_pages", {
  id: serial("id").primaryKey(),
  entityType: varchar("entityType", { length: 32 }).$type<"area" | "item" | "index">().notNull(),
  entityId: bigint("entityId", { mode: "number" }).notNull().default(0),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  generatedAt: timestamp("generatedAt").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Chat messages — Ask-mode conversations, scoped globally or to area/item
// ---------------------------------------------------------------------------
export const chatMessages = mysqlTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    scope: varchar("scope", { length: 32 }).$type<"global" | "area" | "item">().notNull().default("global"),
    scopeId: bigint("scopeId", { mode: "number" }).notNull().default(0),
    role: varchar("role", { length: 32 }).$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("chat_scope_idx").on(t.scope, t.scopeId)],
);

// ---- inferred types ----
export type House = typeof houses.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Measurement = typeof measurements.$inferSelect;
export type Area = typeof areas.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type Idea = typeof ideas.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TimeLog = typeof timeLogs.$inferSelect;
export type Relation = typeof relations.$inferSelect;
export type AppEvent = typeof events.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type ItemLink = typeof itemLinks.$inferSelect;
export type PhotoPin = typeof photoPins.$inferSelect;

// ---------------------------------------------------------------------------
// Storage volumes — one row per mounted volume on a device item (an internal
// drive, an external drive, a NAS or, when the collector cannot tell which
// drive, the computer itself). Bytes, measured by a collector (df); the data
// role is Rick's call and survives every report. A volume that stops being
// reported keeps its last measurement; the UI shows its age.
// ---------------------------------------------------------------------------
export type DataRole = "unique" | "test" | "backup" | "archive" | "system" | "media" | "scratch";

export const storageVolumes = mysqlTable(
  "storage_volumes",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }).notNull(),
    mountPoint: varchar("mountPoint", { length: 255 }).notNull(),
    label: varchar("label", { length: 128 }),
    fsType: varchar("fsType", { length: 32 }),
    device: varchar("device", { length: 128 }),
    container: varchar("container", { length: 64 }), // volumes sharing a container share its capacity (APFS); null = its own container
    capacityBytes: bigint("capacityBytes", { mode: "number" }).notNull(),
    usedBytes: bigint("usedBytes", { mode: "number" }).notNull(),
    dataRole: varchar("dataRole", { length: 16 }).$type<DataRole>(),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    measuredAt: timestamp("measuredAt").notNull().defaultNow(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sv_item_mount_uq").on(t.itemId, t.mountPoint), index("sv_role_idx").on(t.dataRole)],
);

// The biggest top-level directories of a volume at its last measurement (du).
// Replaced wholesale on every report that carries directories.
export const storageDirs = mysqlTable(
  "storage_dirs",
  {
    id: serial("id").primaryKey(),
    volumeId: bigint("volumeId", { mode: "number", unsigned: true }).notNull(),
    path: varchar("path", { length: 512 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    measuredAt: timestamp("measuredAt").notNull().defaultNow(),
  },
  (t) => [index("sd_volume_idx").on(t.volumeId)],
);
