import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { appRouter } from "../router";

/** Build a caller the way a request with (or without) the house header would. */
export function callerFor(houseId: number | null) {
  const headers = new Headers({ authorization: "Bearer " + (process.env.APP_TOKEN ?? "") });
  if (houseId != null) headers.set("x-house-id", String(houseId));
  return appRouter.createCaller({
    req: new Request("http://test/api/trpc", { headers }),
    resHeaders: new Headers(),
    houseId,
  });
}

beforeEach(async () => {
  await resetTestDb();
});

describe("areas.list house scoping", () => {
  it("counts only the context house's items when no houseId input is given", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    await db.insert(items).values([
      { areaId, name: "in A", houseId: h1 },
      { areaId, name: "in B", houseId: h2 },
    ]);

    const scoped = await callerFor(h1).areas.list();
    expect(scoped[0].itemCount).toBe(1);

    const all = await callerFor(null).areas.list();
    expect(all[0].itemCount).toBe(2);

    const explicit = await callerFor(h1).areas.list({ houseId: h2 });
    expect(explicit[0].itemCount).toBe(1);
  });
});
