import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { areas, items } from "@db/schema";
import { getTestDb, resetTestDb, truncateTables } from "./db";
import { getDb } from "../queries/connection";

beforeEach(async () => {
  await resetTestDb();
});

describe("test database seam", () => {
  it("round-trips a row and resetTestDb() clears it", async () => {
    const db = getTestDb();
    await db.insert(areas).values({ slug: "smoke-test", name: "Smoke Test" });
    expect(await db.select().from(areas)).toHaveLength(1);

    await resetTestDb();
    expect(await db.select().from(areas)).toHaveLength(0);
  });

  it("starts clean even though the previous test inserted a row", async () => {
    expect(await getTestDb().select().from(areas)).toHaveLength(0);
  });

  it("routes the app's own getDb() at the test database, so router code under test never touches production", async () => {
    const [{ name }] = (await getDb().execute(sql`select database() as name`))[0] as unknown as { name: string }[];
    expect(name).toMatch(/_test$/);

    const [{ id: areaId }] = await getDb().insert(areas).values({ slug: "a", name: "A" }).$returningId();
    await getDb().insert(items).values({ areaId, name: "thing" });
    expect(await getTestDb().select().from(items)).toHaveLength(1);
  });

  it("truncates every table declared in the schema, not a hand-kept list", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "a", name: "A" }).$returningId();
    await db.insert(items).values({ areaId, name: "thing" });
    await resetTestDb();
    expect(await db.select().from(items)).toHaveLength(0);
    expect(await db.select().from(areas)).toHaveLength(0);
  });
});

describe("truncateTables", () => {
  it("a failing TRUNCATE leaves foreign key checks on for every pooled connection", async () => {
    await expect(truncateTables(["areas", "no_such_table_for_this_test"])).rejects.toThrow();
    // four queries that overlap in time use all four pooled connections,
    // including the one the failed TRUNCATE ran on
    const rows = await Promise.all(
      [0, 1, 2, 3].map(() => getTestDb().execute(sql`select @@SESSION.foreign_key_checks as fk, sleep(0.2) as s`)),
    );
    const fks = rows.map((r) => Number((r[0] as unknown as { fk: number }[])[0].fk));
    expect(fks).toEqual([1, 1, 1, 1]);
  });
});
