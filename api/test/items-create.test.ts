import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { areas, events, items, relations } from "@db/schema";
import { appRouter } from "../router";
import { getTestDb, resetTestDb } from "./db";

// Count LLM attempts; the model still refuses, as in every test (no provider).
const ai = vi.hoisted(() => ({ getModel: vi.fn(async () => Promise.reject(new Error("No LLM configured"))) }));
vi.mock("../lib/ai", async (orig) => ({ ...(await orig<typeof import("../lib/ai")>()), getModel: ai.getModel }));

const caller = () => appRouter.createCaller({ req: new Request("http://test.local/"), resHeaders: new Headers(), houseId: null });

async function areaWithSibling() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  await db.insert(items).values({ areaId, name: "Plugwise espresso machine" });
  return areaId;
}

beforeEach(async () => {
  await resetTestDb();
  ai.getModel.mockClear();
});

describe("items.create suggestLinks", () => {
  it("suggests links by default (name match, LLM attempt, links-suggested event)", async () => {
    const areaId = await areaWithSibling();
    const r = await caller().items.create({ areaId, name: "Plugwise espresso" });
    expect(r.suggestedRelations).toBe(1);
    expect(await getTestDb().select().from(relations).where(eq(relations.fromItemId, r.id))).toHaveLength(1);
    expect(await getTestDb().select().from(events).where(eq(events.action, "links-suggested"))).toHaveLength(1);
    expect(ai.getModel).toHaveBeenCalledTimes(1);
  });

  it("with suggestLinks: false writes no suggested relation, no links-suggested event and makes no LLM call", async () => {
    const areaId = await areaWithSibling();
    const r = await caller().items.create({ areaId, name: "Plugwise espresso", suggestLinks: false });
    expect(r).toEqual({ id: r.id, suggestedRelations: 0, suggestedLinks: [] });
    expect(await getTestDb().select().from(relations)).toHaveLength(0);
    expect(await getTestDb().select().from(events).where(eq(events.action, "links-suggested"))).toHaveLength(0);
    expect(await getTestDb().select().from(events).where(eq(events.action, "created"))).toHaveLength(1);
    expect(ai.getModel).not.toHaveBeenCalled();
  });
});
