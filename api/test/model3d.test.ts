import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { areas, events, items } from "@db/schema";
import { effectiveModel3dRoute, isFavouriteThing, model3dRouteLabel, parseModel3dUrl } from "@db/model3d";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "things", name: "Things" }).$returningId();
  const [{ id: pan }] = await db.insert(items).values({ areaId, name: "pan" }).$returningId();
  const [{ id: mug }] = await db
    .insert(items)
    .values({ areaId, name: "mug", attributes: { favourite: "yes" } })
    .$returningId();
  return { db, areaId, pan, mug };
}

describe("model3d helpers", () => {
  it("treats favourite/favorite yes|true|1 as a favourite", () => {
    expect(isFavouriteThing({ favourite: "yes" })).toBe(true);
    expect(isFavouriteThing({ favorite: "TRUE" })).toBe(true);
    expect(isFavouriteThing({ favourite: 1 })).toBe(true);
    expect(isFavouriteThing({ favourite: "no" })).toBe(false);
    expect(isFavouriteThing(null)).toBe(false);
  });

  it("resolves auto to capture for favourites and meshy otherwise", () => {
    expect(effectiveModel3dRoute("auto", { favourite: "yes" })).toBe("capture");
    expect(effectiveModel3dRoute("auto", {})).toBe("meshy");
    expect(effectiveModel3dRoute("none", { favourite: "yes" })).toBe("none");
    expect(effectiveModel3dRoute(null, null)).toBe("meshy");
    expect(model3dRouteLabel("auto", { favourite: "yes" })).toBe("Auto (Object Capture)");
    expect(model3dRouteLabel("auto", {})).toBe("Auto (Meshy)");
    expect(model3dRouteLabel("agent", {})).toBe("Agent");
  });

  it("accepts /uploads, local/ and http(s) .glb/.usdz/.js; rejects the rest", () => {
    expect(parseModel3dUrl(null)).toBeNull();
    expect(parseModel3dUrl("  ")).toBeNull();
    expect(parseModel3dUrl("/uploads/mug.glb")).toBe("/uploads/mug.glb");
    expect(parseModel3dUrl("local/mug.usdz")).toBe("local/mug.usdz");
    expect(parseModel3dUrl("https://cdn.example/x.js")).toBe("https://cdn.example/x.js");
    expect(parseModel3dUrl("https://cdn.example/x.glb?v=1")).toBe("https://cdn.example/x.glb?v=1");
    expect(parseModel3dUrl("https://cdn.example/x.gltf")).toBe("https://cdn.example/x.gltf");
    expect(() => parseModel3dUrl("https://cdn.example/x.png")).toThrow(/glb/);
    expect(() => parseModel3dUrl("ftp://x.glb")).toThrow(/uploads/);
    expect(() => parseModel3dUrl("not a url")).toThrow(/path or URL/);
  });
});

describe("items model3d columns", () => {
  it("defaults a new Thing to auto / null url and exposes the resolved route", async () => {
    const { db, pan, mug } = await seed();
    const [row] = await db.select().from(items).where(eq(items.id, pan));
    expect(row.model3dRoute).toBe("auto");
    expect(row.model3dUrl).toBeNull();
    expect(row.model3dUpdatedAt).toBeNull();

    const [cols] = (await db.execute(
      sql`select column_name as c from information_schema.columns where table_schema = database() and table_name = 'items' and column_name like 'model3d%' order by 1`,
    )) as unknown as [{ c: string }[]];
    expect(cols.map((r) => r.c)).toEqual(["model3dRoute", "model3dUpdatedAt", "model3dUrl"]);

    const listed = await callerFor(null).items.listAll({});
    expect(listed.find((i) => i.id === pan)).toMatchObject({
      model3dRoute: "auto",
      model3dUrl: null,
      effectiveModel3dRoute: "meshy",
    });
    expect(listed.find((i) => i.id === mug)).toMatchObject({
      model3dRoute: "auto",
      effectiveModel3dRoute: "capture",
    });
    const got = await callerFor(null).items.get({ id: mug });
    expect(got).toMatchObject({ id: mug, model3dRoute: "auto", effectiveModel3dRoute: "capture" });
  });
});

describe("items.setModel3d", () => {
  it("sets route and url on one Thing and on a batch, and never deletes", async () => {
    const { db, areaId, pan, mug } = await seed();
    const api = callerFor(null);
    const [{ id: extra }] = await db.insert(items).values({ areaId, name: "lid" }).$returningId();

    expect(await api.items.setModel3d({ id: pan, route: "meshy" })).toEqual({ ok: true, count: 1 });
    expect(await api.items.setModel3d({ id: pan, url: "/uploads/pan.glb" })).toEqual({ ok: true, count: 1 });
    const after = await api.items.get({ id: pan });
    expect(after).toMatchObject({
      model3dRoute: "meshy",
      model3dUrl: "/uploads/pan.glb",
      effectiveModel3dRoute: "meshy",
    });
    expect(after?.model3dUpdatedAt).toBeTruthy();

    expect(await api.items.setModel3d({ ids: [mug, extra], route: "none" })).toEqual({ ok: true, count: 2 });
    expect((await api.items.get({ id: mug }))?.model3dRoute).toBe("none");
    expect((await api.items.get({ id: extra }))?.effectiveModel3dRoute).toBe("none");

    expect(await api.items.setModel3d({ id: 999999, route: "agent" })).toEqual({ ok: true, count: 0 });
    expect(await db.select().from(items)).toHaveLength(3);
    expect(await db.select().from(events).where(eq(events.action, "model3d"))).toHaveLength(4);
  });

  it("clears the url with null and refuses a bad remote path", async () => {
    const { pan } = await seed();
    const api = callerFor(null);
    await api.items.setModel3d({ id: pan, url: "https://cdn.example/a.usdz" });
    expect((await api.items.get({ id: pan }))?.model3dUrl).toBe("https://cdn.example/a.usdz");
    await api.items.setModel3d({ id: pan, url: null });
    expect((await api.items.get({ id: pan }))?.model3dUrl).toBeNull();
    await expect(api.items.setModel3d({ id: pan, url: "https://cdn.example/a.png" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await api.items.get({ id: pan }))?.model3dUrl).toBeNull();
  });
});
