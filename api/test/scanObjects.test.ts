import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { areas, captures, events, houses, items, roomScans } from "@db/schema";
import { putFile } from "../lib/filestore";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

const GEOMETRY = { walls: [{ points: [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] as [number, number][] }], openings: [] };
type Obj = { kind: string; xM: number; yM: number; wM: number; dM: number; rotDeg?: number; hM?: number };
const TABLE: Obj = { kind: "table", xM: 1, yM: 1, wM: 1.2, dM: 0.8 };
const CHAIR: Obj = { kind: "chair", xM: 3, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 30, hM: 0.95 };
const STORAGE: Obj = { kind: "storage", xM: 4, yM: 3, wM: 0.8, dM: 0.4 };
const SOFA: Obj = { kind: "sofa", xM: 0.5, yM: 3, wM: 2, dM: 0.9 };

async function seed(slugs = ["appliances", "furniture"]) {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  if (slugs.length) await db.insert(areas).values(slugs.map((slug, i) => ({ slug, name: slug, sortOrder: i })));
  return { db, h1 };
}
const scan = (h1: number, objects?: Obj[]) =>
  callerFor(h1).rooms.upsertFromScan({ houseId: h1, name: "Kantoor", source: "roomplan", widthM: 5, depthM: 4, geometry: GEOMETRY, objects });
const allThings = async () => getTestDb().select().from(items).orderBy(asc(items.id));
const scanRows = async () => getTestDb().select().from(roomScans).orderBy(asc(roomScans.id));
const areaId = async (slug: string) => (await getTestDb().select().from(areas).where(eq(areas.slug, slug)))[0].id;

describe("rooms.upsertFromScan with objects", () => {
  it("a first scan creates one detected Thing per object, with scan_kind, rotation and height", async () => {
    const { h1 } = await seed();
    const r = await scan(h1, [TABLE, CHAIR, STORAGE]);
    expect(r).toMatchObject({ created: true, things: { matched: 0, moved: 0, created: 3, missing: 0 } });
    const things = await allThings();
    expect(things.map((t) => [t.name, t.roomId, t.houseId, t.verificationStatus, t.attributes, t.areaId])).toEqual([
      ["Table", r.id, h1, "detected", { scan_kind: "table" }, await areaId("furniture")],
      ["Chair", r.id, h1, "detected", { scan_kind: "chair" }, await areaId("furniture")],
      ["Storage", r.id, h1, "detected", { scan_kind: "storage" }, await areaId("furniture")],
    ]);
    expect(things.map((t) => t.pos)).toEqual([
      { xM: 1, yM: 1, wM: 1.2, dM: 0.8, rotDeg: 0, hM: 0.75 },
      { xM: 3, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 30, hM: 0.95 },
      { xM: 4, yM: 3, wM: 0.8, dM: 0.4, rotDeg: 0, hM: 1.2 },
    ]);
    expect(things[0].description).toBe("Auto-detected from the Kantoor LiDAR scan (RoomPlan) - not yet reviewed.");
    const [s] = await scanRows();
    expect(s.changes.map((c) => c.action)).toEqual(["created", "created", "created"]);
  });

  it("a rescan matches by scan_kind, moves, flags missing and creates; the scan records it and reverting undoes it", async () => {
    const { db, h1 } = await seed();
    const first = await scan(h1, [TABLE, CHAIR, STORAGE]);
    const [table, chair, storage] = await allThings();

    const r = await scan(h1, [{ ...TABLE, xM: 1.3 }, { ...CHAIR, rotDeg: -15 }, SOFA]);
    expect(r).toEqual({ id: first.id, created: false, things: { matched: 2, moved: 1, created: 1, missing: 1 } });
    const after = await allThings();
    expect(after.map((t) => t.id).slice(0, 3)).toEqual([table.id, chair.id, storage.id]);
    expect(after).toHaveLength(4);
    const byId = new Map(after.map((t) => [t.id, t]));
    expect(byId.get(table.id)!.pos).toMatchObject({ xM: 1.3, yM: 1 });
    expect(byId.get(chair.id)!.pos).toMatchObject({ xM: 3, rotDeg: -15, hM: 0.95 });
    expect(byId.get(storage.id)!.attributes).toEqual({ scan_kind: "storage", "scan.missing_at": expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(byId.get(storage.id)!.pos).toEqual(storage.pos);
    const sofa = after[3];
    expect([sofa.name, sofa.attributes]).toEqual(["Sofa", { scan_kind: "sofa" }]);
    expect(await db.select().from(events).where(eq(events.entityId, table.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityType: "item", action: "moved" })]),
    );

    const [, b] = await scanRows();
    const byAction = Object.fromEntries(b.changes.map((c) => [c.itemId, c.action]));
    expect(byAction).toEqual({ [table.id]: "moved", [chair.id]: "matched", [storage.id]: "missing", [sofa.id]: "created" });
    expect(await callerFor(h1).rooms.scans({ roomId: first.id })).toEqual([
      expect.objectContaining({ id: b.id, counts: { matched: 1, moved: 1, created: 1, missing: 1 } }),
      expect.objectContaining({ counts: { matched: 0, moved: 0, created: 3, missing: 0 } }),
    ]);

    expect(await callerFor(h1).rooms.revertScan({ scanId: b.id })).toEqual({ restored: 3, deleted: 1, kept: 0 });
    const reverted = await allThings();
    expect(reverted.map((t) => [t.id, t.pos, t.attributes])).toEqual([table, chair, storage].map((t) => [t.id, t.pos, t.attributes]));
  });

  it("objects: [] or none is a geometry-only scan: no Thing touched, nothing flagged missing", async () => {
    const { h1 } = await seed();
    await scan(h1, [TABLE, CHAIR]);
    const before = await allThings();
    expect(await scan(h1, [])).toMatchObject({ created: false, things: { matched: 0, moved: 0, created: 0, missing: 0 } });
    expect(await scan(h1)).toMatchObject({ created: false, things: { matched: 0, moved: 0, created: 0, missing: 0 } });
    expect(await allThings()).toEqual(before);
    const [, b, c] = await scanRows();
    expect([b.changes, c.changes]).toEqual([[], []]);
  });

  it("an unknown kind is accepted: label is the kind capitalised, topic furniture", async () => {
    const { h1 } = await seed();
    const r = await scan(h1, [{ kind: "plant", xM: 2, yM: 2, wM: 0.4, dM: 0.05 }]);
    expect(r.things.created).toBe(1);
    const [t] = await allThings();
    expect([t.name, t.areaId, t.attributes]).toEqual(["Plant", await areaId("furniture"), { scan_kind: "plant" }]);
    expect(t.pos).toEqual({ xM: 2, yM: 2, wM: 0.4, dM: 0.1, rotDeg: 0 }); // thin footprints widen to 0.1
  });

  it("new RoomPlan kinds map to their topic; a missing topic area falls back to furniture, then to the first area", async () => {
    const { h1 } = await seed(["furniture"]);
    await scan(h1, [{ kind: "refrigerator", xM: 0, yM: 0, wM: 0.7, dM: 0.7 }, { kind: "washerDryer", xM: 2, yM: 0, wM: 0.6, dM: 0.6 }]);
    expect((await allThings()).map((t) => [t.name, t.areaId, t.pos?.hM])).toEqual([
      ["Fridge", await areaId("furniture"), 1.8],
      ["Washer", await areaId("furniture"), 0.85],
    ]);

    await resetTestDb();
    const { h1: h2 } = await seed(["misc", "tools"]);
    await scan(h2, [{ kind: "bed", xM: 0, yM: 0, wM: 2, dM: 1.6 }]);
    const [bed] = await allThings();
    expect([bed.name, bed.areaId, bed.pos?.hM]).toEqual(["Bed", await areaId("misc"), 0.5]);
  });

  it("rejects bad objects and more than 200", async () => {
    const { h1 } = await seed();
    await expect(scan(h1, [{ ...TABLE, kind: "" }])).rejects.toThrow();
    await expect(scan(h1, [{ ...TABLE, kind: "x".repeat(33) }])).rejects.toThrow();
    await expect(scan(h1, [{ ...TABLE, wM: -1 }])).rejects.toThrow();
    await expect(scan(h1, Array.from({ length: 201 }, (_, i) => ({ ...TABLE, xM: i })))).rejects.toThrow();
    expect(await allThings()).toHaveLength(0);
  });
});

describe("inbox.importGeojson keeps skipping objects whose topic area is missing", () => {
  it("a chair in a house without a furniture area is not imported", async () => {
    const { h1 } = await seed(["appliances"]);
    const lat = 52, lon = 5;
    const ll = ([x, y]: [number, number]) => [lon + x / (111320 * Math.cos((lat * Math.PI) / 180)), lat - y / 111320];
    const ring = (x: number, y: number, w: number, d: number) =>
      ([[x, y], [x + w, y], [x + w, y + d], [x, y + d], [x, y]] as [number, number][]).map(ll);
    const features = [
      { geometry: { type: "LineString", coordinates: ([[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] as [number, number][]).map(ll) }, properties: { kind: "Wall" } },
      { geometry: { type: "Polygon", coordinates: [ring(1, 1, 0.5, 0.5)] }, properties: { kind: "chair" } },
      { geometry: { type: "Polygon", coordinates: [ring(3, 1, 0.6, 0.6)] }, properties: { kind: "stove" } },
    ];
    const { key } = await putFile({
      bytes: new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features })),
      fileName: "scan.geojson",
      contentType: "application/geo+json",
    });
    const [{ id: captureId }] = await getTestDb().insert(captures).values({ kind: "file", storageKey: key }).$returningId();
    const r = await callerFor(h1).inbox.importGeojson({ captureId, roomName: "Keuken" });
    expect(r).toMatchObject({ created: 1 });
    expect((await allThings()).map((t) => t.name)).toEqual(["Stove"]);
  });
});
