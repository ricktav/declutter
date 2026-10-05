import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { areas, captures, events, houses, items, photos, roomScans, rooms } from "@db/schema";
import { putFile } from "../lib/filestore";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

// A 5 x 4 m room in the exporter's lon/lat-shaped coordinates (same frame as
// inbox-location.test.ts): the outer walls fix the frame, so an interior
// partition or moved furniture keeps its metres.
const LAT_MAX = 52;
const LON0 = 5;
const toLonLat = ([x, y]: [number, number]): [number, number] => [
  LON0 + x / (111320 * Math.cos((LAT_MAX * Math.PI) / 180)),
  LAT_MAX - y / 111320,
];
type Box = { kind: string; x: number; y: number; w: number; d: number };
const STOVE: Box = { kind: "stove", x: 1, y: 1, w: 0.6, d: 0.6 };
const SINK: Box = { kind: "sink", x: 3, y: 1, w: 0.5, d: 0.5 };
const OVEN: Box = { kind: "oven", x: 1, y: 3, w: 0.6, d: 0.6 };
const TOILET: Box = { kind: "toilet", x: 4, y: 3, w: 0.4, d: 0.6 };
const CHAIR: Box = { kind: "chair", x: 2.5, y: 2.5, w: 0.5, d: 0.5 };
const TABLE: Box = { kind: "table", x: 3.2, y: 2.2, w: 1, d: 0.8 };

function scanFile(boxes: Box[], partition = false): Uint8Array {
  const outer = ([[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] as [number, number][]).map(toLonLat);
  const features = [
    { geometry: { type: "LineString", coordinates: outer }, properties: { kind: "Wall" } },
    ...(partition
      ? [{ geometry: { type: "LineString", coordinates: ([[2.5, 0], [2.5, 1]] as [number, number][]).map(toLonLat) }, properties: { kind: "Wall" } }]
      : []),
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

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  await db.insert(areas).values([
    { slug: "appliances", name: "Appliances" },
    { slug: "furniture", name: "Furniture" },
  ]);
  return { db, h1 };
}
async function captureOf(boxes: Box[], partition = false): Promise<number> {
  const { key } = await putFile({ bytes: scanFile(boxes, partition), fileName: "scan.geojson", contentType: "application/geo+json" });
  const [{ id }] = await getTestDb().insert(captures).values({ kind: "file", storageKey: key }).$returningId();
  return id;
}
const scanRows = async () => getTestDb().select().from(roomScans).orderBy(asc(roomScans.id));
const thing = async (name: string) => (await getTestDb().select().from(items).where(eq(items.name, name)))[0];

/** Scan A: stove, sink, oven. Scan B: stove 0.3 m on, sink, no oven, a partition wall, and toilet, chair and table new. */
async function twoScans(between?: (roomId: number) => Promise<void>) {
  const { db, h1 } = await seed();
  const capA = await captureOf([STOVE, SINK, OVEN]);
  const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: capA, roomName: "Keuken" });
  await between?.(roomId);
  const capB = await captureOf([{ ...STOVE, x: 1.3 }, SINK, TOILET, CHAIR, TABLE], true);
  await callerFor(h1).inbox.importGeojson({ captureId: capB, roomId });
  const [a, b] = await scanRows();
  return { db, h1, roomId, capA, capB, a, b };
}

describe("room_scans from inbox.importGeojson", () => {
  it("a first import records the scan with no before and every Thing created", async () => {
    const { db, h1 } = await seed();
    const captureId = await captureOf([STOVE, SINK]);
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId, roomName: "Keuken" });
    const [scan, ...rest] = await scanRows();
    expect(rest).toHaveLength(0);
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    const things = await db.select().from(items).orderBy(asc(items.id));
    expect(scan).toMatchObject({ roomId, houseId: h1, captureId, source: "geojson", before: null, revertedAt: null });
    expect(scan.after).toEqual({
      walls: room.walls,
      openings: [],
      widthM: room.widthM,
      depthM: room.depthM,
      wallHeightM: null,
      scanDate: room.scanDate!.toISOString(),
      source: "mappedin",
      floor: null,
    });
    expect(scan.changes).toEqual(things.map((t) => ({ itemId: t.id, action: "created", posBefore: null, posAfter: t.pos })));
  });

  it("a rescan records before = the previous after, and each Thing as the merge treated it", async () => {
    const { a, b, capB } = await twoScans();
    expect(b.captureId).toBe(capB);
    expect(b.before).toEqual(a.after);
    expect(b.after.walls!.length).toBe(a.after.walls!.length + 1);
    const stove = await thing("Stove");
    const oven = await thing("Oven");
    const byAction = Object.fromEntries(b.changes.map((c) => [c.itemId, c]));
    expect(byAction[stove.id]).toMatchObject({ action: "moved", posBefore: { xM: 1 }, posAfter: { xM: 1.3 } });
    expect(byAction[(await thing("Sink")).id]).toMatchObject({ action: "matched" });
    expect(byAction[oven.id]).toMatchObject({ action: "missing", attrsBefore: { "scan.missing_at": null } });
    expect(b.changes.filter((c) => c.action === "created").map((c) => c.itemId).sort()).toEqual(
      [(await thing("Toilet")).id, (await thing("Chair")).id, (await thing("Table")).id].sort(),
    );
  });

  it("rooms.scans lists the scans newest first with counts; scanDiff carries names", async () => {
    const { h1, roomId, a, b } = await twoScans();
    const list = await callerFor(h1).rooms.scans({ roomId });
    expect(list.map((s) => [s.id, s.source, s.counts])).toEqual([
      [b.id, "geojson", { matched: 1, moved: 1, created: 3, missing: 1 }],
      [a.id, "geojson", { matched: 0, moved: 0, created: 3, missing: 0 }],
    ]);
    const diff = await callerFor(h1).rooms.scanDiff({ scanId: b.id });
    expect(diff.scan).toMatchObject({ id: b.id, roomId, source: "geojson", revertedAt: null });
    expect(diff.before).toEqual(a.after);
    expect(diff.changes.map((c) => [c.name, c.action, c.status]).sort()).toEqual(
      [
        ["Chair", "created", "active"],
        ["Oven", "missing", "active"],
        ["Sink", "matched", "active"],
        ["Stove", "moved", "active"],
        ["Table", "created", "active"],
        ["Toilet", "created", "active"],
      ],
    );
    await expect(callerFor(h1).rooms.scanDiff({ scanId: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rooms.revertScan", () => {
  it("only the latest scan of a room can be reverted", async () => {
    const { h1, a } = await twoScans();
    await expect(callerFor(h1).rooms.revertScan({ scanId: a.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Only the latest scan of a room can be reverted",
    });
    expect((await scanRows()).every((s) => s.revertedAt == null)).toBe(true);
  });

  it("restores walls and positions, deletes untouched new Things, keeps touched ones, clears the missing flag", async () => {
    // between the scans the room was given a floor and its source changed by hand
    const { db, h1, roomId, a, b } = await twoScans((roomId) =>
      getTestDb().update(rooms).set({ floor: "ground", source: "manual" }).where(eq(rooms.id, roomId)).then(() => undefined),
    );
    expect(b.before).toMatchObject({ source: "manual", floor: "ground" });
    expect(b.after).toMatchObject({ source: "mappedin", floor: "ground" });
    await db.update(rooms).set({ floor: "attic" }).where(eq(rooms.id, roomId));
    const chair = await thing("Chair");
    const table = await thing("Table");
    const toilet = await thing("Toilet");
    await callerFor(h1).items.setVerification({ id: chair.id, verificationStatus: "confirmed" });
    await db.insert(photos).values({ itemId: table.id, storageKey: "test/never-there.jpg" });
    expect((await thing("Oven")).attributes).toMatchObject({ "scan.missing_at": expect.any(String) });

    const r = await callerFor(h1).rooms.revertScan({ scanId: b.id });
    expect(r).toEqual({ restored: 3, deleted: 1, kept: 2 });

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room.walls).toEqual(a.after.walls);
    expect(room.scanDate!.toISOString()).toBe(a.after.scanDate);
    expect([room.source, room.floor]).toEqual(["manual", "ground"]);
    expect((await thing("Stove")).pos).toMatchObject({ xM: 1, yM: 1 });
    expect((await thing("Oven")).attributes).toEqual({ scan_kind: "oven" });
    expect((await thing("Sink")).attributes).toEqual({ scan_kind: "sink" });
    expect(await thing("Toilet")).toBeUndefined();
    expect((await thing("Chair")).id).toBe(chair.id);
    expect((await thing("Table")).id).toBe(table.id);

    const [scanB] = await db.select().from(roomScans).where(eq(roomScans.id, b.id));
    expect(scanB.revertedAt).not.toBeNull();
    const [ev] = await db.select().from(events).where(and(eq(events.entityType, "room"), eq(events.action, "scan-reverted")));
    expect(ev.summary).toMatch(/^Scan of "Keuken" from .* undone: 3 restored, 1 deleted, 2 kept \(Chair, Table\)$/);
    const kept = await db.select().from(events).where(eq(events.action, "scan-reverted-kept"));
    expect(kept.map((e) => e.entityId).sort()).toEqual([chair.id, table.id].sort());

    const diff = await callerFor(h1).rooms.scanDiff({ scanId: b.id });
    expect(diff.changes.find((c) => c.itemId === toilet.id)).toMatchObject({ name: "(deleted)", status: "deleted" });

    // undone once is undone
    await expect(callerFor(h1).rooms.revertScan({ scanId: b.id })).rejects.toMatchObject({ code: "CONFLICT" });

    // the first scan is now the latest: undoing it clears the plan and its untouched Things
    const r2 = await callerFor(h1).rooms.revertScan({ scanId: a.id });
    expect(r2).toEqual({ restored: 0, deleted: 3, kept: 0 });
    const [bare] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect([bare.walls, bare.openings, bare.widthM, bare.depthM, bare.scanDate]).toEqual([null, null, null, null, null]);
    expect((await db.select().from(items)).map((t) => t.name).sort()).toEqual(["Chair", "Table"]);
  });

  it("a missing flag from an earlier scan comes back as it was", async () => {
    const { db, h1 } = await seed();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, SINK]), roomName: "Keuken" });
    await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE]), roomId });
    const sink = await thing("Sink");
    await db.update(items).set({ attributes: { ...sink.attributes, "scan.missing_at": "2026-01-01" } }).where(eq(items.id, sink.id));
    await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE]), roomId });
    const latest = (await scanRows()).at(-1)!;
    await callerFor(h1).rooms.revertScan({ scanId: latest.id });
    expect((await thing("Sink")).attributes).toEqual({ scan_kind: "sink", "scan.missing_at": "2026-01-01" });
  });
});

describe("room_scans from rooms.upsertFromScan", () => {
  const G1 = { walls: [{ points: [[0, 0], [3, 0], [3, 2], [0, 2], [0, 0]] as [number, number][] }], openings: [] };
  const G2 = { walls: [{ points: [[0, 0], [4, 0], [4, 2], [0, 2], [0, 0]] as [number, number][] }], openings: [] };

  it("records a geometry-only scan, and reverting it restores the earlier geometry", async () => {
    const { db, h1 } = await seed();
    const caller = callerFor(h1);
    const first = await caller.rooms.upsertFromScan({ houseId: h1, name: "Schuur", source: "roomplan", widthM: 3, depthM: 2, wallHeightM: 2.4, geometry: G1 });
    await caller.rooms.upsertFromScan({ houseId: h1, name: "Schuur", source: "roomplan", widthM: 4, depthM: 2, wallHeightM: 2.5, geometry: G2 });
    const [a, b] = await scanRows();
    expect(a).toMatchObject({ roomId: first.id, houseId: h1, source: "roomplan", captureId: null, before: null, changes: [] });
    expect(a.after).toMatchObject({ walls: G1.walls, widthM: 3, wallHeightM: 2.4 });
    expect(b.before).toEqual(a.after);
    expect(b.after).toMatchObject({ walls: G2.walls, widthM: 4 });

    expect(await caller.rooms.revertScan({ scanId: b.id })).toEqual({ restored: 0, deleted: 0, kept: 0 });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, first.id));
    expect([room.walls, room.widthM, room.depthM, room.wallHeightM]).toEqual([G1.walls, 3, 2, 2.4]);
    expect(room.scanDate!.toISOString()).toBe(a.after.scanDate);
  });
});

describe("rooms.revertScan, more cases", () => {
  it("after an undo the same capture can be imported again and records a new scan", async () => {
    const { db, h1 } = await seed();
    const captureId = await captureOf([STOVE, SINK]);
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId, roomName: "Keuken" });
    const [a] = await scanRows();
    await callerFor(h1).rooms.revertScan({ scanId: a.id });
    const [cap] = await db.select().from(captures).where(eq(captures.id, captureId));
    expect(cap.status).toBe("pending");
    const again = await callerFor(h1).inbox.importGeojson({ captureId, roomId });
    expect(again).toMatchObject({ roomId, created: 2 });
    const rows = await scanRows();
    // oldest first: the undone scan, then the new one
    expect(rows.map((r) => [r.captureId, r.revertedAt != null])).toEqual([
      [captureId, true],
      [captureId, false],
    ]);
  });

  it("keeps a created Thing a user renamed since the scan", async () => {
    const { h1, b } = await twoScans();
    const toilet = await thing("Toilet");
    await callerFor(h1).items.update({ id: toilet.id, name: "Wc beneden" });
    const r = await callerFor(h1).rooms.revertScan({ scanId: b.id });
    expect(r).toMatchObject({ deleted: 2, kept: 1 });
    expect((await thing("Wc beneden")).id).toBe(toilet.id);
  });

  it("skips a Thing deleted since the scan and one moved to another room", async () => {
    const { db, h1, b } = await twoScans();
    const sink = await thing("Sink");
    const stove = await thing("Stove");
    const [{ id: other }] = await db.insert(rooms).values({ houseId: h1, name: "Gang", source: "manual" }).$returningId();
    await db.delete(items).where(eq(items.id, sink.id));
    await db.update(items).set({ roomId: other }).where(eq(items.id, stove.id));
    const r = await callerFor(h1).rooms.revertScan({ scanId: b.id });
    expect(r).toEqual({ restored: 1, deleted: 3, kept: 0 }); // only the oven's flag
    const after = await thing("Stove");
    expect([after.roomId, after.pos?.xM]).toEqual([other, 1.3]);
  });

  it("a legacy Thing loses the scan_kind it learned from the undone scan", async () => {
    const { db, h1 } = await seed();
    const [{ id: roomId }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", source: "manual" }).$returningId();
    const [furniture] = await db.select().from(areas).where(eq(areas.slug, "furniture"));
    await db.insert(items).values({
      areaId: furniture.id,
      houseId: h1,
      roomId,
      name: "Chair 2",
      attributes: { colour: "red" },
      pos: { xM: 2.5, yM: 2.5, wM: 0.5, dM: 0.5, rotDeg: 0 },
    });
    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([CHAIR]), roomId });
    expect(r).toMatchObject({ matched: 1, created: 0 });
    expect((await thing("Chair 2")).attributes).toEqual({ colour: "red", scan_kind: "chair" });
    const [scan] = await scanRows();
    expect(scan.before).toMatchObject({ walls: null, source: "manual" });
    await callerFor(h1).rooms.revertScan({ scanId: scan.id });
    expect((await thing("Chair 2")).attributes).toEqual({ colour: "red" });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect([room.walls, room.source]).toEqual([null, "manual"]);
  });
});

describe("rescan with a rejected Thing", () => {
  it("a false positive the scanner keeps finding matches its rejected Thing and is left alone", async () => {
    const { db, h1 } = await seed();
    const { roomId } = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, CHAIR]), roomName: "Keuken" });
    const chair = await thing("Chair");
    await callerFor(h1).items.setVerification({ id: chair.id, verificationStatus: "rejected" });

    const r = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE, { ...CHAIR, x: 2.8 }]), roomId });
    expect(r).toMatchObject({ created: 0, matched: 2, moved: 0, missing: 0 });
    const same = await thing("Chair");
    expect([same.pos, same.attributes, same.verificationStatus]).toEqual([chair.pos, chair.attributes, "rejected"]);
    expect(await db.select().from(events).where(and(eq(events.entityId, chair.id), eq(events.action, "moved")))).toHaveLength(0);
    expect((await db.select().from(items)).length).toBe(2);

    // not detected at all: a rejected Thing is never flagged missing
    const r2 = await callerFor(h1).inbox.importGeojson({ captureId: await captureOf([STOVE]), roomId });
    expect(r2).toMatchObject({ missing: 0 });
    expect((await thing("Chair")).attributes).toEqual({ scan_kind: "chair" });
  });
});
