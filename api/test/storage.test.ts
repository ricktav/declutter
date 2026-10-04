import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTestDb, resetTestDb } from "./db";

beforeEach(resetTestDb);

describe("storage tables", () => {
  it("exist with their key columns", async () => {
    const db = getTestDb();
    const [cols] = (await db.execute(
      sql`select table_name t, column_name c from information_schema.columns where table_schema = database() and table_name in ('storage_volumes','storage_dirs') order by 1, ordinal_position`,
    )) as unknown as [{ t: string; c: string }[]];
    const by = (t: string) => cols.filter((r) => r.t === t).map((r) => r.c);
    expect(by("storage_volumes")).toEqual(
      expect.arrayContaining(["id", "itemId", "mountPoint", "capacityBytes", "usedBytes", "dataRole", "measuredAt"]),
    );
    expect(by("storage_dirs")).toEqual(expect.arrayContaining(["id", "volumeId", "path", "bytes", "measuredAt"]));
  });
});
