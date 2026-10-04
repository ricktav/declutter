import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTestDb, resetTestDb } from "./db";

beforeEach(resetTestDb);

describe("energy tables", () => {
  it("exist with their key columns", async () => {
    const db = getTestDb();
    const [cols] = (await db.execute(
      sql`select table_name t, column_name c from information_schema.columns where table_schema = database() and table_name in ('energy_months','energy_tariffs') order by 1, ordinal_position`,
    )) as unknown as [{ t: string; c: string }[]];
    const by = (t: string) => cols.filter((r) => r.t === t).map((r) => r.c);
    expect(by("energy_months")).toEqual(
      expect.arrayContaining(["id", "itemId", "month", "kwhNormal", "kwhOffpeak", "kwhReturnedNormal", "kwhReturnedOffpeak", "kwhProduced", "avgW", "baseW", "peakW", "hours", "source", "measuredAt", "createdAt"]),
    );
    expect(by("energy_tariffs")).toEqual(
      expect.arrayContaining(["id", "validFrom", "normalEurKwh", "offpeakEurKwh", "feedInEurKwh", "feedInCostEurKwh", "fixedEurDay", "note"]),
    );
  });
});
