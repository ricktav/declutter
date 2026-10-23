import { beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { areas, captures, houses, items, rooms } from "@db/schema";
import { parseGeojsonFloor } from "../lib/geojsonFloor";
import { putFile } from "../lib/filestore";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

const LAT_MAX = 52;
const LON0 = 5;
const toLonLat = ([x, y]: [number, number]): [number, number] => [
  LON0 + x / (111320 * Math.cos((LAT_MAX * Math.PI) / 180)),
  LAT_MAX - y / 111320,
];

function mappedInScan(boxes: { kind: string; x: number; y: number; w: number; d: number }[]) {
  const wall = ([[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] as [number, number][]).map(toLonLat);
  return {
    type: "FeatureCollection",
    features: [
      { geometry: { type: "LineString", coordinates: wall }, properties: { kind: "Wall" } },
      {
        geometry: { type: "LineString", coordinates: ([ [2, 0], [2.9, 0] ] as [number, number][]).map(toLonLat) },
        properties: { kind: "Door" },
      },
      ...boxes.map((b) => ({
        geometry: {
          type: "Polygon",
          coordinates: [
            ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.d], [b.x, b.y + b.d], [b.x, b.y]] as [number, number][]).map(
              toLonLat,
            ),
          ],
        },
        properties: { kind: b.kind },
      })),
    ],
  };
}

function homebaseScan() {
  return {
    type: "FeatureCollection",
    properties: { format: "homebase-scan/1" },
    features: [
      {
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]]],
        },
        properties: { featureType: "room", name: "Keuken" },
      },
      {
        geometry: { type: "LineString", coordinates: [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] },
        properties: { featureType: "wall" },
      },
      {
        geometry: { type: "LineString", coordinates: [[2, 0], [2.9, 0]] },
        properties: { featureType: "opening", kind: "door" },
      },
      {
        geometry: { type: "LineString", coordinates: [[0, 1], [0, 2]] },
        properties: { featureType: "opening", kind: "window" },
      },
      {
        geometry: {
          type: "Polygon",
          coordinates: [[[1, 1], [1.6, 1], [1.6, 1.6], [1, 1.6], [1, 1]]],
        },
        properties: { featureType: "object", kind: "stove", wM: 0.6, dM: 0.6, hM: 0.9 },
      },
      {
        geometry: { type: "Point", coordinates: [2.5, 2] },
        properties: { featureType: "photo", file: "IMG_0001.jpg" },
      },
    ],
  };
}

describe("parseGeojsonFloor MappedIn (no featureType)", () => {
  it("projects lon/lat walls and treats every Polygon as furniture, including kind room", () => {
    const parsed = parseGeojsonFloor(mappedInScan([{ kind: "stove", x: 1, y: 1, w: 0.6, d: 0.6 }, { kind: "room", x: 0, y: 0, w: 5, d: 4 }]));
    expect(parsed).not.toBeNull();
    expect(parsed!.photos).toEqual([]);
    expect(parsed!.widthM).toBeCloseTo(5, 1);
    expect(parsed!.depthM).toBeCloseTo(4, 1);
    expect(parsed!.walls.map((w) => w.kind)).toEqual(["wall", "door"]);
    expect(parsed!.furniturePolys.map((p) => p.kind)).toEqual(["stove", "room"]);
    const stove = parsed!.furniturePolys[0];
    const xs = stove.ring.map((p) => p[0]);
    const ys = stove.ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(1, 1);
    expect(Math.min(...ys)).toBeCloseTo(1, 1);
  });
});

describe("parseGeojsonFloor homebase-scan/1", () => {
  it("classifies by featureType: room is outline, openings are not walls, photos stay off the plan", () => {
    const parsed = parseGeojsonFloor(homebaseScan());
    expect(parsed).not.toBeNull();
    expect(parsed!.furniturePolys.map((p) => p.kind)).toEqual(["stove"]);
    expect(parsed!.furniturePolys[0]).toMatchObject({ wM: 0.6, dM: 0.6, hM: 0.9 });
    expect(parsed!.walls.map((w) => w.kind)).toEqual(["wall", "door", "window"]);
    expect(parsed!.widthM).toBeCloseTo(5, 1);
    expect(parsed!.depthM).toBeCloseTo(4, 1);
    expect(parsed!.photos).toEqual([{ xM: 2.5, yM: 2, properties: { featureType: "photo", file: "IMG_0001.jpg" } }]);
  });

  it("also activates when a feature has featureType and no collection format", () => {
    const raw = homebaseScan();
    delete (raw as { properties?: unknown }).properties;
    raw.features[1].properties = { featureType: "wall" };
    const parsed = parseGeojsonFloor(raw);
    expect(parsed!.walls.some((w) => w.kind === "wall")).toBe(true);
    expect(parsed!.furniturePolys).toHaveLength(1);
  });
});

describe("inbox.importGeojson homebase-scan/1 vs MappedIn", () => {
  async function seedHouse() {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    await db.insert(areas).values({ slug: "appliances", name: "Appliances" });
    await db.insert(areas).values({ slug: "furniture", name: "Furniture" });
    return { db, h1 };
  }
  async function captureOf(body: unknown): Promise<number> {
    const { key } = await putFile({
      bytes: new TextEncoder().encode(JSON.stringify(body)),
      fileName: "scan.geojson",
      contentType: "application/geo+json",
    });
    const [{ id }] = await getTestDb().insert(captures).values({ kind: "file", storageKey: key }).$returningId();
    return id;
  }

  it("MappedIn still creates a Thing for a room-kind polygon", async () => {
    const { h1 } = await seedHouse();
    const r = await callerFor(h1).inbox.importGeojson({
      captureId: await captureOf(mappedInScan([{ kind: "room", x: 0.2, y: 0.2, w: 1, d: 1 }])),
      roomName: "Keuken",
    });
    expect(r.created).toBe(1);
    const things = await getTestDb().select().from(items).orderBy(asc(items.id));
    expect(things.map((t) => [t.name, t.attributes])).toEqual([["room", { scan_kind: "room" }]]);
  });

  it("homebase-scan/1 imports objects only; room polygon and photo are not Things", async () => {
    const { db, h1 } = await seedHouse();
    const r = await callerFor(h1).inbox.importGeojson({
      captureId: await captureOf(homebaseScan()),
      roomName: "Keuken",
    });
    expect(r).toMatchObject({ created: 1, matched: 0, missing: 0 });
    const things = await db.select().from(items).orderBy(asc(items.id));
    expect(things).toHaveLength(1);
    expect(things[0]).toMatchObject({
      name: "Stove",
      verificationStatus: "detected",
      attributes: { scan_kind: "stove" },
    });
    expect(things[0].pos).toMatchObject({ wM: 0.6, dM: 0.6, hM: 0.9 });
    const [room] = await db.select().from(rooms);
    expect(room.walls?.map((w) => w.kind)).toEqual(["wall", "door", "window"]);
    expect(room.widthM).toBeCloseTo(5, 1);
    expect(room.depthM).toBeCloseTo(4, 1);
  });
});
