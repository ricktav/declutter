import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, events, items, relations } from "@db/schema";
import { appRouter } from "../router";
import { getTestDb, resetTestDb } from "./db";

const caller = () => appRouter.createCaller({ req: new Request("http://test.local/"), resHeaders: new Headers() });

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
