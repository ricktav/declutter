// A Thing can be created without a topic: it lands in the "Things" topic,
// which is created once, on first need, in the database being written.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, itemLinks, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { DEFAULT_TOPIC_SLUG } from "../lib/defaultTopic";

beforeEach(async () => {
  await resetTestDb();
});

const thingsTopics = () => getTestDb().select().from(areas).where(eq(areas.slug, DEFAULT_TOPIC_SLUG));

describe("default topic", () => {
  it("items.create without areaId creates the Things topic once and files into it", async () => {
    const c = callerFor(null);
    const a = await c.items.create({ name: "lamp", suggestLinks: false });
    const b = await c.items.create({ name: "chair", suggestLinks: false });
    const topics = await thingsTopics();
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe("Things");
    const rows = await getTestDb().select().from(items);
    expect(rows.map((r) => [r.id, r.areaId]).sort()).toEqual([[a.id, topics[0].id], [b.id, topics[0].id]].sort());
  });

  it("an explicit areaId still wins and creates no Things topic", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "kitchen", name: "Kitchen" }).$returningId();
    const r = await callerFor(null).items.create({ areaId, name: "pan", suggestLinks: false });
    const [row] = await db.select().from(items).where(eq(items.id, r.id));
    expect(row.areaId).toBe(areaId);
    expect(await thingsTopics()).toHaveLength(0);
  });

  it("inbox.acceptMany: a new Thing without areaId goes to Things, with its note", async () => {
    const db = getTestDb();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "a lamp" }).$returningId();
    await callerFor(null).inbox.acceptMany({ id: capId, items: [{ itemId: null, itemName: "lamp" }] });

    const [things] = await thingsTopics();
    const [lamp] = await db.select().from(items).where(eq(items.name, "lamp"));
    expect(lamp.areaId).toBe(things.id);
    const [note] = await db.select().from(itemLinks).where(eq(itemLinks.itemId, lamp.id));
    expect(note.areaId).toBe(things.id);
  });

  it("inbox.acceptMany onto an existing Thing needs no topic and creates no Things topic", async () => {
    const db = getTestDb();
    const [{ id: kitchen }] = await db.insert(areas).values({ slug: "kitchen", name: "Kitchen" }).$returningId();
    const [{ id: pan }] = await db.insert(items).values({ areaId: kitchen, name: "pan" }).$returningId();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "the pan" }).$returningId();
    await callerFor(null).inbox.acceptMany({ id: capId, items: [{ itemId: pan, itemName: "pan" }] });

    expect(await thingsTopics()).toHaveLength(0);
    const [row] = await db.select().from(items).where(eq(items.id, pan));
    expect(row.areaId).toBe(kitchen);
  });
});
