import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { captures, events, houses, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { writeTestJpeg } from "./fixtures";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: h2 }] = await db.insert(houses).values({ name: "Boot" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: kajuit }] = await db.insert(rooms).values({ houseId: h2, name: "Kajuit", floor: "deck", source: "manual" }).$returningId();
  return { db, h1, h2, keuken, kajuit };
}

describe("inbox.create stamps the session house", () => {
  it("writes captures.houseId from x-house-id; no header stays unknown", async () => {
    const { db, h1 } = await seed();
    const a = await callerFor(h1).inbox.create({ kind: "note", rawText: "in huis" });
    const b = await callerFor(null).inbox.create({ kind: "note", rawText: "nowhere" });
    const [rowA] = await db.select().from(captures).where(eq(captures.id, a.id));
    const [rowB] = await db.select().from(captures).where(eq(captures.id, b.id));
    expect(rowA.houseId).toBe(h1);
    expect(rowB.houseId).toBeNull();
  });
});

describe("inbox.list house / unknown / dismissed", () => {
  it("no input still lists every status (Flow / iOS)", async () => {
    const { db, h1 } = await seed();
    await db.insert(captures).values({ kind: "note", rawText: "p", status: "pending", houseId: h1 });
    await db.insert(captures).values({ kind: "note", rawText: "d", status: "dismissed", houseId: h1 });
    const rows = await callerFor(h1).inbox.list();
    expect(rows.map((r) => r.status).sort()).toEqual(["dismissed", "pending"]);
  });

  it("view open hides dismissed; dismissed view is only Hidden", async () => {
    const { db, h1 } = await seed();
    await db.insert(captures).values({ kind: "note", rawText: "p", status: "pending", houseId: h1 });
    await db.insert(captures).values({ kind: "note", rawText: "d", status: "dismissed", houseId: h1 });
    const open = await callerFor(h1).inbox.list({ view: "open" });
    const hidden = await callerFor(h1).inbox.list({ view: "dismissed" });
    expect(open.map((r) => r.status)).toEqual(["pending"]);
    expect(hidden.map((r) => r.status)).toEqual(["dismissed"]);
  });

  it("houseId scopes; includeUnknown adds captures with no house", async () => {
    const { db, h1, h2 } = await seed();
    await db.insert(captures).values({ kind: "note", rawText: "thuis", houseId: h1 });
    await db.insert(captures).values({ kind: "note", rawText: "boot", houseId: h2 });
    await db.insert(captures).values({ kind: "note", rawText: "loose" });
    const scoped = await callerFor(h1).inbox.list({ houseId: h1, view: "open" });
    const withUnknown = await callerFor(h1).inbox.list({ houseId: h1, includeUnknown: true, view: "open" });
    expect(scoped.map((r) => r.rawText)).toEqual(["thuis"]);
    expect(withUnknown.map((r) => r.rawText).sort()).toEqual(["loose", "thuis"]);
  });

  it("a location photo's room house wins over captures.houseId", async () => {
    const { db, h1, h2, kajuit } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-inbox-house.jpg", houseId: h1 }).$returningId();
    await db.insert(photos).values({ sourceCaptureId: capId, roomId: kajuit, storageKey: "local/test-fake-inbox-house-loc.jpg" });
    const [row] = await callerFor(null).inbox.list();
    expect(row.houseId).toBe(h2);
    expect(row.roomName).toBe("Kajuit");
    expect(row.houseName).toBe("Boot");
  });
});

describe("inbox.assignPlace / restore", () => {
  it("house only stamps captures.houseId and logs", async () => {
    const { db, h1 } = await seed();
    const [{ id }] = await db.insert(captures).values({ kind: "note", rawText: "x" }).$returningId();
    const res = await callerFor(h1).inbox.assignPlace({ ids: [id], houseId: h1 });
    expect(res).toMatchObject({ ok: true, count: 1, houseId: h1, roomId: null });
    const [row] = await db.select().from(captures).where(eq(captures.id, id));
    expect(row.houseId).toBe(h1);
    const ev = await db.select().from(events);
    expect(ev.some((e) => e.entityType === "capture" && e.action === "placed" && e.entityId === id)).toBe(true);
  });

  it("room makes a location photo and sets the house from that Place", async () => {
    const { db, h1, keuken } = await seed();
    const key = await writeTestJpeg();
    const [{ id }] = await db.insert(captures).values({ kind: "image", storageKey: key }).$returningId();
    await callerFor(h1).inbox.assignPlace({ ids: [id], roomId: keuken });
    const [cap] = await db.select().from(captures).where(eq(captures.id, id));
    expect(cap.houseId).toBe(h1);
    const [loc] = await db.select().from(photos);
    expect(loc.roomId).toBe(keuken);
    expect(loc.sourceCaptureId).toBe(id);
  });

  it("restore puts dismissed back to pending and logs", async () => {
    const { db, h1 } = await seed();
    const [{ id }] = await db.insert(captures).values({ kind: "note", rawText: "x", status: "dismissed", houseId: h1 }).$returningId();
    const res = await callerFor(h1).inbox.restore({ ids: [id] });
    expect(res.count).toBe(1);
    const [row] = await db.select().from(captures).where(eq(captures.id, id));
    expect(row.status).toBe("pending");
    const ev = await db.select().from(events);
    expect(ev.some((e) => e.action === "restored" && e.entityId === id)).toBe(true);
  });
});
