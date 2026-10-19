// api/test/pins-room.test.ts
// pins.listForRoom: the room page's Schema view reads every pin on the
// Photos of a room and of the rooms cut from it, with each Thing's role,
// Type, tags, decision and area colour, in one call.
import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

// storage keys never touch disk here: listForRoom only reads rows
async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "lab", name: "Lab", color: "#123456" }).$returningId();
  const room = async (name: string, parentRoomId: number | null = null) =>
    (await db.insert(rooms).values({ houseId: h1, name, floor: "ground", source: "manual", parentRoomId }).$returningId())[0].id;
  const zolder = await room("Zolder");
  const hoek = await room("Hoek", zolder); // cut from Zolder
  const plank = await room("Plank", hoek); // cut from Hoek
  const keuken = await room("Keuken");
  const photo = async (roomId: number, title: string) =>
    (await db.insert(photos).values({ roomId, title, storageKey: `local/pins-room-${title}.jpg` }).$returningId())[0].id;
  const thing = async (name: string, extra: Partial<typeof items.$inferInsert> = {}) =>
    (await db.insert(items).values({ areaId, houseId: h1, roomId: zolder, name, ...extra }).$returningId())[0].id;
  const pin = async (photoId: number, itemId: number | null, extra: Partial<typeof photoPins.$inferInsert> = {}) =>
    (await db.insert(photoPins).values({ photoId, itemId, xPct: 50, yPct: 50, wPct: 10, hPct: 10, label: "", ...extra }).$returningId())[0].id;
  return { db, h1, areaId, zolder, hoek, plank, keuken, photo, thing, pin };
}

describe("pins.listForRoom", () => {
  it("returns the pins of the room's Photos and its child rooms' Photos, ordered, with the Thing's fields", async () => {
    const { h1, zolder, hoek, plank, keuken, photo, thing, pin } = await seed();
    const p2 = await photo(zolder, "b");
    const p1 = await photo(zolder, "a");
    const pChild = await photo(hoek, "child");
    const pGrandchild = await photo(plank, "grandchild");
    const pOther = await photo(keuken, "other");

    const mini = await thing("Mac mini", {
      attributes: { role: "desktop", type: "mac-mini", tags: "Apple, Homelab ,apple", brand: "Apple", ip: "10.0.0.5", hostname: "mini", ram_gb: 16, serial: "X1" },
      decision: "keep",
    });
    const kb = await thing("Keyboard", { attributes: { role: "keyboard", brand: "Logitech" }, decision: "sell" });
    const plain = await thing("Box");
    const gone = await thing("Old laptop", { status: "archived", decision: "toss" });
    const wrong = await thing("Not a thing", { verificationStatus: "rejected" });

    const a = await pin(p2, mini);
    const b = await pin(p1, kb, { flagged: true });
    const c = await pin(p1, null, { label: "unknown", origin: "ai", status: "suggested" });
    await pin(p1, plain, { status: "dismissed" });
    await pin(p2, gone);
    await pin(p2, wrong);
    const d = await pin(pChild, plain);
    const e = await pin(pGrandchild, plain);
    await pin(pOther, kb);

    const rows = await callerFor(h1).pins.listForRoom({ roomId: zolder });
    expect(rows.map((r) => [r.photoId, r.id])).toEqual(
      [
        [p1, b],
        [p1, c],
        [p2, a],
        [pChild, d],
        [pGrandchild, e],
      ].sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    );

    const miniRow = rows.find((r) => r.id === a)!;
    expect(miniRow).toMatchObject({
      photoId: p2,
      photoTitle: "b",
      photoStorageKey: "local/pins-room-b.jpg",
      itemId: mini,
      xPct: 50,
      wPct: 10,
      status: "confirmed",
      flagged: false,
      origin: "user",
      itemName: "Mac mini",
      itemAreaColor: "#123456",
    });
    expect(miniRow.item).toEqual({
      id: mini,
      name: "Mac mini",
      role: "desktop",
      type: "mac-mini",
      tags: ["apple", "homelab"],
      decision: "keep",
      verificationStatus: "confirmed",
      status: "active",
      areaId: miniRow.item!.areaId,
      attributes: { ip: "10.0.0.5", hostname: "mini", ram_gb: 16, brand: "Apple" },
    });

    const kbRow = rows.find((r) => r.id === b)!;
    expect(kbRow.flagged).toBe(true);
    expect(kbRow.item).toMatchObject({ role: "keyboard", type: "keyboard", tags: ["logitech"], decision: "sell" });

    const loose = rows.find((r) => r.id === c)!;
    expect(loose).toMatchObject({ item: null, itemName: null, itemAreaColor: null, label: "unknown", status: "suggested" });

    expect(rows.find((r) => r.id === d)!.item).toMatchObject({ role: null, type: null, tags: [], decision: null });

    // a child room alone does not reach up to its parent's Photos
    const childRows = await callerFor(h1).pins.listForRoom({ roomId: hoek });
    expect(childRows.map((r) => r.id)).toEqual([d, e]);
  });

  it("works for a caller without a house, and returns [] for an empty or unknown room", async () => {
    const { zolder, keuken, photo, thing, pin } = await seed();
    const p = await photo(zolder, "x");
    const t = await thing("Lamp");
    const id = await pin(p, t);
    expect((await callerFor(null).pins.listForRoom({ roomId: zolder })).map((r) => r.id)).toEqual([id]);

    expect(await callerFor(null).pins.listForRoom({ roomId: keuken })).toEqual([]);
    await photo(keuken, "bare");
    expect(await callerFor(null).pins.listForRoom({ roomId: keuken })).toEqual([]);
    expect(await callerFor(null).pins.listForRoom({ roomId: 999999 })).toEqual([]);
  });
});

describe("pins.listForPhoto includeDismissed", () => {
  it("leaves dismissed pins out by default and adds them on request", async () => {
    const { h1, zolder, photo, thing, pin } = await seed();
    const p = await photo(zolder, "dismissed");
    const t = await thing("Lamp");
    const live = await pin(p, t);
    const gone = await pin(p, t, { status: "dismissed" });
    const caller = callerFor(h1);
    expect((await caller.pins.listForPhoto({ photoId: p })).map((r) => r.id)).toEqual([live]);
    const all = await caller.pins.listForPhoto({ photoId: p, includeDismissed: true });
    expect(all.map((r) => r.id).sort((a, b) => a - b)).toEqual([live, gone].sort((a, b) => a - b));
    expect(all.find((r) => r.id === gone)).toMatchObject({ status: "dismissed", itemName: "Lamp" });
  });
});
