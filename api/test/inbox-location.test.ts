import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { areas, captures, events, houses, items, rooms } from "@db/schema";
import { putFile } from "../lib/filestore";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "a pan and a pot" }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

describe("inbox.acceptMany", () => {
  it("files new items into the given room with the room's house", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "pan" },
        { areaId, itemId: null, itemName: "pot" },
      ],
    });
    const rows = await db.select().from(items);
    expect(rows.map((r) => [r.roomId, r.houseId])).toEqual([[keuken, h1], [keuken, h1]]);
  });
  it("without a room, new items are unplaced in the context house", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan" }] });
    const [row] = await db.select().from(items);
    expect([row.roomId, row.houseId]).toEqual([null, h1]);
  });
});

describe("inbox.importGeojson input handling", () => {
  it("needs a room id or name", async () => {
    const { h1, capId } = await seed();
    await expect(callerFor(h1).inbox.importGeojson({ captureId: capId })).rejects.toThrow();
  });
  it("unknown roomId", async () => {
    const { h1, capId } = await seed();
    await expect(callerFor(h1).inbox.importGeojson({ captureId: capId, roomId: 999999 })).rejects.toThrow(/Room not found/);
  });
  it("roomName without any house", async () => {
    const { capId } = await seed();
    await expect(callerFor(null).inbox.importGeojson({ captureId: capId, roomName: "Nieuw" })).rejects.toThrow(/Pick a house first/);
  });
});

describe("inbox.importGeojson rescan merge", () => {
  // A 5 x 4 m room drawn in the exporter's lon/lat-shaped coordinates; the
  // walls fix the projection frame, so furniture inside keeps its metres.
  const LAT_MAX = 52;
  const LON0 = 5;
  const toLonLat = ([x, y]: [number, number]): [number, number] => [
    LON0 + x / (111320 * Math.cos((LAT_MAX * Math.PI) / 180)),
    LAT_MAX - y / 111320,
  ];
  type Box = { kind: string; x: number; y: number; w: number; d: number };
  const STOVE: Box = { kind: "stove", x: 1, y: 1, w: 0.6, d: 0.6 };
  const SINK: Box = { kind: "sink", x: 3, y: 1, w: 0.5, d: 0.5 };
  function scanFile(boxes: Box[]): Uint8Array {
    const wall = ([[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] as [number, number][]).map(toLonLat);
    const features = [
      { geometry: { type: "LineString", coordinates: wall }, properties: { kind: "Wall" } },
      ...boxes.map((b) => ({
        geometry: {
          type: "Polygon",
          coordinates: [([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.d], [b.x, b.y + b.d], [b.x, b.y]] as [number, number][]).map(toLonLat)],
        },
        properties: { kind: b.kind },
      })),
    ];
    return new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features }));
  }

  async function seedScan() {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    await db.insert(areas).values({ slug: "appliances", name: "Appliances" });
    return { db, h1 };
  }
  async function captureOf(boxes: Box[]): Promise<number> {
    const { key } = await putFile({ bytes: scanFile(boxes), fileName: "scan.geojson", contentType: "application/geo+json" });
    const [{ id }] = await getTestDb().insert(captures).values({ kind: "file", storageKey: key }).$returningId();
    return id;
  }
  const things = async () =>
    (await getTestDb().select().from(items).orderBy(asc(items.id))).map((t) => ({
      id: t.id,
      name: t.name,
      verificationStatus: t.verificationStatus,
      attributes: t.attributes,
      pos: t.pos,
    }));

  // Captures are inserted directly (captureOf), not through inbox.create:
  // createCapture dedups identical bytes, so the same scan uploaded twice
  // would be one capture and the second import would be refused.
  it("the same scan imported twice creates nothing new and keeps ids and positions", async () => {
    const { db, h1 } = await seedScan();
    const first = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    expect(first).toMatchObject({ created: 2, matched: 0, missing: 0 });
    const before = await things();
    expect(before.map((t) => [t.name, t.attributes])).toEqual([["Stove", { scan_kind: "stove" }], ["Sink", { scan_kind: "sink" }]]);
    expect(before[0].pos).toMatchObject({ xM: 1, yM: 1, wM: 0.6, dM: 0.6, hM: 0.9 });

    const old = new Date("2026-01-01T00:00:00Z");
    await db.update(rooms).set({ scanDate: old }).where(eq(rooms.id, first.roomId));
    const second = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    expect(second).toMatchObject({ roomId: first.roomId, created: 0, matched: 2, moved: 0, missing: 0 });
    expect(await things()).toEqual(before);
    const [room] = await db.select().from(rooms).where(eq(rooms.id, first.roomId));
    expect(room.scanDate!.getTime()).toBeGreaterThan(old.getTime());
    const [ev] = await db.select().from(events).where(and(eq(events.entityType, "room"), eq(events.action, "rescanned")));
    expect(ev.summary).toBe('Room "Keuken" rescanned: 2 matched (0 moved), 0 new, 0 missing');
  });

  it("a renamed, confirmed Thing still matches by scan_kind; only its position changes", async () => {
    const { db, h1 } = await seedScan();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    const [stove] = await things();
    await db.update(items).set({ name: "Smeg fornuis", verificationStatus: "confirmed" }).where(eq(items.id, stove.id));

    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([{ ...STOVE, x: 1.3 }, SINK]), roomId });
    expect(r).toMatchObject({ created: 0, matched: 2, moved: 1, missing: 0 });
    const after = await things();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ id: stove.id, name: "Smeg fornuis", verificationStatus: "confirmed" });
    expect(after[0].pos).toMatchObject({ xM: 1.3, yM: 1, wM: 0.6, dM: 0.6, rotDeg: 0 });
    const moved = await db.select().from(events).where(and(eq(events.entityType, "item"), eq(events.action, "moved")));
    expect(moved.map((e) => [e.entityId, e.summary])).toEqual([[stove.id, "Moved by the Keuken rescan (0.30 m)"]]);
  });

  it("a Thing not in the new scan is flagged missing, and cleared when it comes back", async () => {
    const { h1 } = await seedScan();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    const [, sink] = await things();

    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE]), roomId });
    expect(r).toMatchObject({ created: 0, matched: 1, missing: 1 });
    const flagged = (await things())[1];
    expect(flagged.attributes).toEqual({ scan_kind: "sink", "scan.missing_at": expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(flagged.pos).toEqual(sink.pos);
    expect(flagged.verificationStatus).toBe("detected");

    await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomId });
    const back = await things();
    expect(back).toHaveLength(2);
    expect(back[1].attributes).toEqual({ scan_kind: "sink" });
  });

  it("a Thing moved further than the tolerance becomes a new Thing; the old one is missing, not moved", async () => {
    const { h1 } = await seedScan();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    const [stove] = await things();

    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([{ ...STOVE, x: 4, y: 3 }, SINK]), roomId });
    expect(r).toMatchObject({ created: 1, matched: 1, missing: 1 });
    const after = await things();
    expect(after).toHaveLength(3);
    expect(after[0].pos).toEqual(stove.pos);
    expect(after[0].attributes).toMatchObject({ "scan.missing_at": expect.any(String) });
    expect(after[2]).toMatchObject({ name: "Stove 2", attributes: { scan_kind: "stove" } });
    expect(after[2].pos).toMatchObject({ xM: 4, yM: 3 });
  });

  it("a Thing the user moved on the plan matches its rescan at the new place", async () => {
    const { db, h1 } = await seedScan();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    const [stove] = await things();
    await db.update(items).set({ pos: { ...stove.pos!, xM: 3.5, yM: 2.5 } }).where(eq(items.id, stove.id));

    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([{ ...STOVE, x: 3.6, y: 2.6 }, SINK]), roomId });
    expect(r).toMatchObject({ created: 0, matched: 2, missing: 0 });
    expect((await things())[0].pos).toMatchObject({ xM: 3.6, yM: 2.6 });
  });

  it("importing the same capture twice is refused and writes nothing", async () => {
    const { db, h1 } = await seedScan();
    const captureId = await captureOf([STOVE, SINK]);
    await callerFor(h1).inbox.importGeojson({ captureId, roomName: "Keuken" });
    const before = await things();
    const evCount = (await db.select().from(events)).length;
    await expect(callerFor(h1).inbox.importGeojson({ captureId, roomName: "Keuken" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This capture was already imported.",
    });
    expect(await things()).toEqual(before);
    expect((await db.select().from(events)).length).toBe(evCount);
  });
});
