import { beforeEach, describe, expect, it } from "vitest";
import { areas, captures, houses, items, photos, relations, rooms } from "@db/schema";
import { classify, LATER_DAYS, type QueueThing } from "../lib/queue";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

const now = new Date("2026-10-16T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const base: QueueThing = {
  id: 0,
  status: "active",
  verificationStatus: "confirmed",
  roomId: 1,
  parentId: null,
  decision: null,
  decidedAt: null,
  areaSlug: "house",
  attributes: {},
};
const t = (id: number, p: Partial<QueueThing> = {}): QueueThing => ({ ...base, id, ...p });

describe("classify", () => {
  it("puts a detected Thing in toCheck only, never in place or decide", () => {
    const q = classify([t(1, { verificationStatus: "detected", roomId: null })], { now });
    expect(q).toMatchObject({ toCheck: [1], toPlace: [], toDecide: [] });
  });

  it("ignores rejected and archived Things", () => {
    const q = classify([t(1, { verificationStatus: "rejected", roomId: null }), t(2, { status: "archived", roomId: null })], { now });
    expect(q).toMatchObject({ toCheck: [], toPlace: [], toDecide: [] });
  });

  it("asks for a Place and a Decision independently", () => {
    const q = classify([t(1, { roomId: null }), t(2, { decision: "keep", decidedAt: now, roomId: null })], { now });
    expect(q.toPlace).toEqual([1, 2]);
    expect(q.toDecide).toEqual([1]);
  });

  it(`returns a Later after ${LATER_DAYS} days, not before`, () => {
    const q = classify(
      [t(1, { decision: "later", decidedAt: daysAgo(LATER_DAYS - 1) }), t(2, { decision: "later", decidedAt: daysAgo(LATER_DAYS + 1) })],
      { now },
    );
    expect(q.toDecide).toEqual([2]);
  });

  it("scopes to lab Things with the lab lens and asks for role and backup", () => {
    const things = [
      t(1, { areaSlug: "computers" }),
      t(2, { attributes: { role: "laptop" } }),
      t(3, { attributes: { role: "laptop" } }),
      t(4, { attributes: { role: "storage" }, parentId: 2 }),
      t(5, { attributes: { role: "nas", "lab.backup": "none-needed" } }),
      t(6, { attributes: { role: "meter" } }),
      t(7, { areaSlug: "computers", attributes: { "lab.exclude": "yes" } }),
      t(8, {}),
    ];
    const q = classify(things, { now, lens: "lab", backedUp: new Set([3]) });
    expect(q.toDecide).toEqual([1, 2, 3, 4, 5]);
    expect(q.lens).toEqual({ needsRole: [1], needsBackup: [2] });
    expect(classify(things, { now }).lens).toBeNull();
  });
});

describe("items.queue", () => {
  let h1: number;
  let h2: number;
  let room1: number;
  let areaId: number;

  beforeEach(async () => {
    await resetTestDb();
    const db = getTestDb();
    [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    [{ id: room1 }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", source: "manual" }).$returningId();
    [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  });

  it("counts per session house, with house-less snaps in every house", async () => {
    const db = getTestDb();
    const [{ id: lamp }] = await db.insert(items).values({ areaId, houseId: h1, roomId: room1, name: "lamp" }).$returningId();
    const [{ id: box }] = await db.insert(items).values({ areaId, houseId: h1, name: "box", decision: "keep" }).$returningId();
    await db.insert(items).values({ areaId, houseId: h2, name: "elsewhere", verificationStatus: "detected" });
    const [{ id: inH1 }] = await db.insert(captures).values({ kind: "image", storageKey: "a.jpg", houseId: h1 }).$returningId();
    const [{ id: noHouse }] = await db.insert(captures).values({ kind: "note", rawText: "x" }).$returningId();
    const [{ id: inH2 }] = await db.insert(captures).values({ kind: "note", rawText: "y", houseId: h2 }).$returningId();
    await db.insert(captures).values({ kind: "note", rawText: "done", status: "processed", houseId: h1 });

    const q = await callerFor(h1).items.queue();
    expect(q).toMatchObject({ toSort: [inH1, noHouse], toCheck: [], toPlace: [box], toDecide: [lamp], lens: null, laterDays: LATER_DAYS });
    expect(q.counts).toEqual({ toSort: 2, toCheck: 0, toPlace: 1, toDecide: 1, needsRole: 0, needsBackup: 0 });
    expect((await callerFor(h2).items.queue()).toSort).toEqual([noHouse, inH2]);
    expect((await callerFor(null).items.queue()).counts.toCheck).toBe(1);
    expect((await callerFor(h2).items.queue({ houseId: h1 })).toDecide).toEqual([lamp]);
  });

  it("takes a snap's house from its location Photo's room, and filters by room", async () => {
    const db = getTestDb();
    const [{ id: snap }] = await db.insert(captures).values({ kind: "image", storageKey: "b.jpg", houseId: h2 }).$returningId();
    await db.insert(photos).values({ storageKey: "b.jpg", roomId: room1, sourceCaptureId: snap });
    expect((await callerFor(h1).items.queue()).toSort).toEqual([snap]);
    expect((await callerFor(h2).items.queue()).toSort).toEqual([]);
    expect((await callerFor(h1).items.queue({ roomId: room1 })).toSort).toEqual([snap]);
  });

  it("answers the lab lens's backup question from backs-up relations", async () => {
    const db = getTestDb();
    const [{ id: laptop }] = await db.insert(items).values({ areaId, houseId: h1, roomId: room1, name: "laptop", attributes: { role: "laptop" } }).$returningId();
    const [{ id: nas }] = await db.insert(items).values({ areaId, houseId: h1, roomId: room1, name: "nas", attributes: { role: "nas" } }).$returningId();
    expect((await callerFor(h1).items.queue({ lens: "lab" })).lens?.needsBackup).toEqual([laptop, nas]);
    await db.insert(relations).values({ fromItemId: nas, toItemId: laptop, type: "backs-up" });
    expect((await callerFor(h1).items.queue({ lens: "lab" })).lens?.needsBackup).toEqual([nas]);
  });
});
