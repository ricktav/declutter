// api/test/room-scan-links.test.ts
// rooms.linkScan is a pointer only: no Things, no photos, not upsertFromScan.
import { beforeEach, describe, expect, it } from "vitest";
import { areas, events, houses, items, photos, roomScanLinks, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: zolder }] = await db.insert(rooms).values({ houseId: h1, name: "Zolder", floor: "attic", source: "manual" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, keuken, zolder, itemId };
}

describe("rooms.linkScan / linkedScans", () => {
  it("records an external scan on a room, lists it, and never touches Things or photos", async () => {
    const { db, h1, keuken, itemId } = await seed();
    const api = callerFor(h1);
    const capturedAt = new Date("2026-10-01T12:00:00Z");
    const first = await api.rooms.linkScan({
      roomId: keuken,
      source: "homebase-3d",
      externalId: "house-capture/5",
      capturedAt,
      metadata: { session: "5", kind: "roomplan" },
    });
    expect(first.created).toBe(true);
    expect(first).toMatchObject({
      roomId: keuken,
      source: "homebase-3d",
      externalId: "house-capture/5",
      metadata: { session: "5", kind: "roomplan" },
    });
    expect(first.capturedAt).toEqual(capturedAt);

    const listed = await api.rooms.linkedScans({ roomId: keuken });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(first.id);
    expect(await api.rooms.linkedScans({ roomId: 999 })).toEqual([]);

    expect(await db.select().from(items)).toHaveLength(1);
    expect(await db.select().from(photos)).toHaveLength(0);
    expect((await db.select().from(items))[0].id).toBe(itemId);
    expect((await db.select().from(events)).map((e) => e.action)).toContain("scan-linked");
  });

  it("re-links the same external scan to another room and does not create a second row", async () => {
    const { db, h1, keuken, zolder } = await seed();
    const api = callerFor(h1);
    const first = await api.rooms.linkScan({ roomId: keuken, source: "homebase-3d", externalId: "scan-a" });
    const again = await api.rooms.linkScan({ roomId: zolder, source: "homebase-3d", externalId: "scan-a" });
    expect(again).toMatchObject({ id: first.id, roomId: zolder, created: false });
    expect(await db.select().from(roomScanLinks)).toHaveLength(1);
    expect((await api.rooms.linkedScans({ roomId: keuken })).map((r) => r.externalId)).toEqual([]);
    expect((await api.rooms.linkedScans({ roomId: zolder })).map((r) => r.externalId)).toEqual(["scan-a"]);
  });

  it("refuses an unknown room and does not call upsertFromScan", async () => {
    const { h1, keuken } = await seed();
    const api = callerFor(h1);
    await expect(api.rooms.linkScan({ roomId: 999, source: "homebase-3d", externalId: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // upsertFromScan would create or update geometry; linkScan left the room alone
    const room = (await api.rooms.get({ id: keuken }))!;
    expect(room.walls).toBeNull();
    expect(room.items).toHaveLength(1);
  });
});
