import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(resetTestDb);

async function seed() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: pc }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "dockermac-1", attributes: { role: "desktop", hostname: "dockermac-1" } })
    .$returningId();
  const [{ id: chair }] = await db.insert(items).values({ areaId, houseId, name: "Stoel", attributes: { role: "furniture" } }).$returningId();
  return { houseId, pc, chair };
}

describe("services.report", () => {
  it("writes containers JSON onto a machine and replaces the next snapshot", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    const first = await c.services.report({
      itemId: pc,
      source: "test",
      containers: [
        { name: "nginx", status: "running", port: 80 },
        { name: "caddy", status: "running" },
      ],
    });
    expect(first).toEqual({ containers: 2, node: 0, web: 0 });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.containers))).toEqual([
      { name: "nginx", status: "running", port: 80 },
      { name: "caddy", status: "running" },
    ]);
    await c.services.report({ itemId: pc, source: "test", containers: [{ name: "nginx" }] });
    const [after] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(after.attributes?.containers))).toEqual([{ name: "nginx" }]);
  });

  it("clears a list when the report sends an empty array, and leaves omitted keys", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({
      itemId: pc,
      source: "test",
      containers: [{ name: "nginx" }],
      node: [{ name: "homebase" }],
    });
    await c.services.report({ itemId: pc, source: "test", containers: [] });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(row.attributes?.containers).toBeUndefined();
    expect(JSON.parse(String(row.attributes?.node))).toEqual([{ name: "homebase" }]);
  });

  it("refuses a non-machine or archived item", async () => {
    const { houseId, pc, chair } = await seed();
    const c = callerFor(houseId);
    await expect(c.services.report({ itemId: chair, source: "test", containers: [{ name: "x" }] })).rejects.toThrow(/not a machine/);
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, pc));
    await expect(c.services.report({ itemId: pc, source: "test", containers: [{ name: "x" }] })).rejects.toThrow(/archived/);
  });
});
