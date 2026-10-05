import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { areas, events, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

const walls = [
  { points: [[0, 0], [4, 0]] as [number, number][] },
  { points: [[4, 0], [4, 3]] as [number, number][] },
  { points: [[4, 3], [0, 3]] as [number, number][], kind: "door" as const },
  { points: [[0, 3], [0, 0]] as [number, number][] },
];

async function seed() {
  const db = getTestDb();
  const [{ id: h }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: kantoor }] = await db
    .insert(rooms)
    .values({ houseId: h, name: "Kantoor", source: "roomplan", widthM: 4, depthM: 3, walls, openings: [] })
    .$returningId();
  const [{ id: bare }] = await db.insert(rooms).values({ houseId: h, name: "Zolder", source: "manual" }).$returningId();
  const caller = callerFor(h);
  const thing = async (name: string, roomId: number | null, pos: Parameters<typeof caller.items.update>[0]["pos"]) => {
    const { id } = await caller.items.create({ areaId, name, roomId, suggestLinks: false });
    if (pos !== undefined) await caller.items.update({ id, pos });
    return id;
  };
  return { db, caller, kantoor, bare, thing };
}

describe("items.snapToWall", () => {
  it("pulls a Thing through the wall back flush, keeps the rest of pos, logs a moved event", async () => {
    const { db, caller, kantoor, thing } = await seed();
    const id = await thing("Storage 4", kantoor, { xM: -0.28, yM: 1, wM: 0.8, dM: 0.5, rotDeg: 0, hM: 1.9, baseM: 0 });
    const r = await caller.items.snapToWall({ id });
    expect(r).toEqual({
      pos: { xM: 0, yM: 1, wM: 0.8, dM: 0.5, rotDeg: 0, hM: 1.9, baseM: 0 },
      movedM: 0.28,
      wall: { kind: "wall", side: "left" },
    });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.pos).toEqual(r.pos);
    const ev = await db.select().from(events).where(and(eq(events.entityId, id), eq(events.action, "moved")));
    expect(ev.map((e) => e.summary)).toEqual(["Snapped to the left wall (0.28 m)"]);
  });

  it("names a door segment as the wall it snapped to", async () => {
    const { caller, kantoor, thing } = await seed();
    const id = await thing("Kast", kantoor, { xM: 1.5, yM: 2.2, wM: 1, dM: 0.5, rotDeg: 0 });
    const r = await caller.items.snapToWall({ id });
    expect(r.wall).toEqual({ kind: "door", side: "bottom" });
    expect(r.pos.yM).toBeCloseTo(2.5);
    expect(r.movedM).toBeCloseTo(0.3);
  });

  it("refuses with PRECONDITION_FAILED when no wall is within 0.5 m", async () => {
    const { caller, kantoor, thing } = await seed();
    const id = await thing("Tafel", kantoor, { xM: 1.5, yM: 1, wM: 1, dM: 0.8, rotDeg: 0 });
    await expect(caller.items.snapToWall({ id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "No wall within 0.5 m" });
  });

  it("refuses with NOT_FOUND when the Thing has no room or no pos", async () => {
    const { caller, kantoor, thing } = await seed();
    const unplaced = await thing("Lamp", null, undefined);
    const noPos = await thing("Stoel", kantoor, undefined);
    await expect(caller.items.snapToWall({ id: unplaced })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.items.snapToWall({ id: noPos })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.items.snapToWall({ id: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses with BAD_REQUEST when the Thing's own room has no plan", async () => {
    const { caller, bare, thing } = await seed();
    const id = await thing("Doos", bare, { xM: 0.1, yM: 0.1, wM: 0.5, dM: 0.5, rotDeg: 0 });
    await expect(caller.items.snapToWall({ id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
