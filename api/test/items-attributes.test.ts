import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, events, houses, items, relations } from "@db/schema";
import { appRouter } from "../router";
import { getTestDb, resetTestDb } from "./db";

const caller = () => appRouter.createCaller({ req: new Request("http://test.local/"), resHeaders: new Headers(), houseId: null });

async function makeItem(attributes: Record<string, string | number> | null = null) {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id }] = await db.insert(items).values({ areaId, name: "MacBook", attributes }).$returningId();
  return id;
}
const attrsOf = async (id: number) => (await getTestDb().query.items.findFirst({ where: eq(items.id, id) }))?.attributes ?? null;

beforeEach(async () => {
  await resetTestDb();
});

describe("items.patchAttributes", () => {
  it("sets the given keys and keeps every other key", async () => {
    const id = await makeItem({ role: "laptop", serial: "C02X" });
    await caller().items.patchAttributes({ id, set: { "sell.ask_price": 250, model: "MacBook Pro" } });
    expect(await attrsOf(id)).toEqual({ role: "laptop", serial: "C02X", "sell.ask_price": 250, model: "MacBook Pro" });
  });

  it("removes a key for null or an empty string, and stores NULL when no key is left", async () => {
    const id = await makeItem({ role: "laptop", serial: "C02X" });
    await caller().items.patchAttributes({ id, set: { serial: null } });
    expect(await attrsOf(id)).toEqual({ role: "laptop" });
    await caller().items.patchAttributes({ id, set: { role: "" } });
    expect(await attrsOf(id)).toBeNull();
  });

  it("logs one event for a change and none when nothing changes", async () => {
    const id = await makeItem({ role: "laptop" });
    await caller().items.patchAttributes({ id, set: { role: "laptop", gone: null } });
    expect(await getTestDb().select().from(events)).toHaveLength(0);
    await caller().items.patchAttributes({ id, set: { "lab.wiped_at": "2026-10-02" } });
    const logged = await getTestDb().select().from(events);
    expect(logged).toHaveLength(1);
    expect(logged[0].summary).toContain("lab.wiped_at = 2026-10-02");
  });

  it("rejects an unknown item", async () => {
    await expect(caller().items.patchAttributes({ id: 999, set: { role: "nas" } })).rejects.toThrow(/not found/);
  });
});

describe("items.attributeKeysForTopic", () => {
  it("returns keys and values by frequency for active items in that topic", async () => {
    const db = getTestDb();
    const [{ id: computers }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    const [{ id: kitchen }] = await db.insert(areas).values({ slug: "kitchen", name: "Kitchen" }).$returningId();
    await db.insert(items).values([
      { areaId: computers, name: "a", attributes: { role: "laptop", ram_gb: 16 } },
      { areaId: computers, name: "b", attributes: { role: "desktop", storage_gb: 512 } },
      { areaId: computers, name: "c", attributes: { role: "laptop" } },
      { areaId: computers, name: "gone", status: "archived", attributes: { role: "nas", hostname: "old" } },
      { areaId: kitchen, name: "pan", attributes: { material: "steel" } },
    ]);
    const rows = await caller().items.attributeKeysForTopic({ areaId: computers });
    expect(rows.map((r) => r.key)).toEqual(["role", "ram_gb", "storage_gb"]);
    expect(rows[0]).toMatchObject({
      key: "role",
      count: 3,
      values: [
        { value: "laptop", count: 2 },
        { value: "desktop", count: 1 },
      ],
    });
    expect(rows.find((r) => r.key === "hostname")).toBeUndefined();
    expect(rows.find((r) => r.key === "material")).toBeUndefined();
  });

  it("keeps identity keys but does not suggest their values, only an IP prefix", async () => {
    const db = getTestDb();
    const [{ id: computers }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    await db.insert(items).values([
      { areaId: computers, name: "a", attributes: { serial: "C02X", ip: "10.50.0.10", role: "laptop" } },
      { areaId: computers, name: "b", attributes: { serial: "C02Y", ip: "10.50.0.11" } },
    ]);
    const rows = await caller().items.attributeKeysForTopic({ areaId: computers });
    expect(rows.find((r) => r.key === "serial")?.values).toEqual([]);
    expect(rows.find((r) => r.key === "ip")?.values).toEqual([{ value: "10.50.0.", count: 2 }]);
    expect(rows.find((r) => r.key === "role")?.values.map((v) => v.value)).toEqual(["laptop"]);
  });
});

describe("items.findAttributeDuplicates", () => {
  it("warns on the same identity value in the same house, including key variants and MAC form", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    const [{ id: a }] = await db.insert(items).values({
      areaId, houseId: h1, name: "MacBook", attributes: { serial: " C02X ", mac: "AA:BB:CC:DD:EE:FF", ip: "10.50.0.10" },
    }).$returningId();
    const [{ id: b }] = await db.insert(items).values({
      areaId, houseId: h1, name: "Clone", attributes: { serial_number: "c02x", mac_address: "aa-bb-cc-dd-ee-ff" },
    }).$returningId();
    await db.insert(items).values({
      areaId, houseId: h2, name: "Other house", attributes: { serial: "C02X", hostname: "nas-1" },
    });
    const r = await caller().items.findAttributeDuplicates({ itemId: a });
    expect(r.clashes.map((c) => c.kind).sort()).toEqual(["mac", "serial"]);
    expect(r.clashes.find((c) => c.kind === "serial")?.others).toEqual([
      expect.objectContaining({ id: b, name: "Clone", key: "serial_number" }),
    ]);
    expect(r.ipPrefix).toBe("10.50.0.");
  });

  it("checks draft attributes and does not treat the current item as a duplicate", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    const [{ id: a }] = await db.insert(items).values({
      areaId, houseId: h1, name: "A", attributes: { hostname: "nas-1" },
    }).$returningId();
    await db.insert(items).values({
      areaId, houseId: h1, name: "B", attributes: { host: "NAS-1" },
    });
    const saved = await caller().items.findAttributeDuplicates({ itemId: a });
    expect(saved.clashes).toHaveLength(1);
    const draft = await caller().items.findAttributeDuplicates({ itemId: a, attributes: { role: "nas" } });
    expect(draft.clashes).toHaveLength(0);
  });
});

describe("items.listRelations", () => {
  it("returns only relations of the asked type", async () => {
    const laptop = await makeItem();
    const [{ id: nas }] = await getTestDb()
      .insert(items)
      .values({ areaId: (await getTestDb().select().from(areas))[0].id, name: "NAS" })
      .$returningId();
    await getTestDb().insert(relations).values([
      { fromItemId: nas, toItemId: laptop, type: "backs-up" },
      { fromItemId: nas, toItemId: laptop, type: "related-to" },
    ]);
    const rows = await caller().items.listRelations({ type: "backs-up" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromItemId: nas, toItemId: laptop, type: "backs-up" });
  });
});
