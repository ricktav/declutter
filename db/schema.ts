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
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const items = mysqlTable(
  "items",
  {
    id: serial("id").primaryKey(),
    areaId: bigint("areaId", { mode: "number", unsigned: true }).notNull(),
    houseId: bigint("houseId", { mode: "number", unsigned: true }),
    parentId: bigint("parentId", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).$type<"active" | "archived">().notNull().default("active"),
    attributes: json("attributes").$type<Record<string, string | number>>(),
    floor: varchar("floor", { length: 32 }),
    room: varchar("room", { length: 128 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
    archivedAt: timestamp("archivedAt"),
  },
  (t) => [index("items_area_idx").on(t.areaId), index("items_house_idx").on(t.houseId)],
);

// ---------------------------------------------------------------------------
// Attachments — images / files (storageKey), links (url), notes (content)
// ---------------------------------------------------------------------------
export const attachments = mysqlTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    kind: varchar("kind", { length: 32 }).$type<"image" | "link" | "note" | "file">().notNull(),
    title: varchar("title", { length: 255 }),
    content: text("content"),
    url: text("url"),
    storageKey: varchar("storageKey", { length: 512 }),
    mimeType: varchar("mimeType", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("att_item_idx").on(t.itemId)],
);

// ---------------------------------------------------------------------------
// Inbox captures — frictionless drop zone, triaged (optionally by AI) later
// ---------------------------------------------------------------------------
export const captures = mysqlTable("captures", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 32 }).$type<"note" | "link" | "image" | "file">().notNull().default("note"),
  rawText: text("rawText"),
  url: text("url"),
  storageKey: varchar("storageKey", { length: 512 }),
  status: varchar("status", { length: 32 }).$type<"pending" | "triaged" | "dismissed" | "processed">().notNull().default("pending"),
  suggestion: json("suggestion").$type<TriageSuggestion>(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export interface TriageSuggestion {
  areaSlug?: string;
  itemName?: string;
  matchedItemId?: number;
  isNewItem?: boolean;
  attributes?: Record<string, string>;
  note?: string;
  confidence?: "high" | "medium" | "low";
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
// Photo annotations — pins on image attachments, linked to items
// ---------------------------------------------------------------------------
export const photoAnnotations = mysqlTable(
  "photo_annotations",
  {
    id: serial("id").primaryKey(),
    attachmentId: bigint("attachmentId", { mode: "number", unsigned: true }).notNull(),
    xPct: double("xPct").notNull(),
    yPct: double("yPct").notNull(),
    wPct: double("wPct"),
    hPct: double("hPct"),
    label: varchar("label", { length: 255 }).notNull().default(""),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    origin: varchar("origin", { length: 32 }).$type<"user" | "ai">().notNull().default("user"),
    status: varchar("status", { length: 32 }).$type<"suggested" | "confirmed">().notNull().default("confirmed"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("pins_att_idx").on(t.attachmentId), index("pins_item_idx").on(t.itemId)],
);

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
  (t) => [index("events_created_idx").on(t.createdAt)],
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
export type Area = typeof areas.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type Idea = typeof ideas.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TimeLog = typeof timeLogs.$inferSelect;
export type Relation = typeof relations.$inferSelect;
export type AppEvent = typeof events.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type PhotoAnnotation = typeof photoAnnotations.$inferSelect;
