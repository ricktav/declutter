import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items, storageVolumes } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

let areaId: number;
let h1: number;
let h2: number;

beforeEach(async () => {
  await resetTestDb();
  const db = getTestDb();
  [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
});

async function thing(houseId: number, attributes: Record<string, string | number>, status: "active" | "archived" = "active") {
  const [{ id }] = await getTestDb().insert(items).values({ areaId, houseId, name: "t", attributes, status }).$returningId();
  return id;
}

describe("settings.views", () => {
  it("shows neither view without machines or storage in any house", async () => {
    await thing(h1, { brand: "Ikea" });
    expect(await callerFor(h1).settings.views()).toEqual({ systems: false, storage: false });
  });

  it("shows Systems once a machine exists in any house, whatever the session house", async () => {
    await thing(h2, { role: "server" });
    expect(await callerFor(h1).settings.views()).toEqual({ systems: true, storage: false });
    expect((await callerFor(h2).settings.views()).systems).toBe(true);
    expect((await callerFor(null).settings.views()).systems).toBe(true);
  });

  it("shows Storage for a drive, or for a volume reported on a computer", async () => {
    const laptop = await thing(h2, { role: "laptop" });
    expect((await callerFor(h2).settings.views()).storage).toBe(false);
    await getTestDb().insert(storageVolumes).values({ itemId: laptop, mountPoint: "/", capacityBytes: 100, usedBytes: 10 });
    expect(await callerFor(h2).settings.views()).toEqual({ systems: true, storage: true });
    await thing(h1, { role: "storage" });
    expect((await callerFor(h1).settings.views()).storage).toBe(true);
  });

  it("ignores archived Things", async () => {
    await thing(h1, { role: "nas" }, "archived");
    expect(await callerFor(h1).settings.views()).toEqual({ systems: false, storage: false });
  });
});
