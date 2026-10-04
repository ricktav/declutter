import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { areas, events, houses, items, relations, energyMonths } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { EnergyReportError, applyEnergyReport, currentMonth, meterKind } from "../lib/energy";

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

async function seedMeters() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "smarthome", name: "Smarthome" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis RT" }).$returningId();
  const [{ id: other }] = await db.insert(houses).values({ name: "Josies" }).$returningId();
  const mk = async (name: string, attributes: Record<string, string>, h = houseId) =>
    (await db.insert(items).values({ areaId, houseId: h, name, attributes }).$returningId())[0].id;
  const fridgePlug = await mk("Plugwise – Koelkast", { role: "meter", meter_kind: "plug", mac: "000D6F000278B4A3" });
  const tvPlug = await mk("Plugwise – TV / Mac / UPC", { role: "meter", meter_kind: "plug", mac: "000D6F0000AF6505" });
  const grid = await mk("Slimme meter", { role: "meter", meter_kind: "grid" });
  const solar = await mk("SolarEdge omvormer", { role: "meter", meter_kind: "solar" });
  const tv = await mk("Television", {});
  const macMini = await mk("Mac mini", { role: "desktop" });
  const elsewhere = await mk("Plugwise – elders", { role: "meter", meter_kind: "plug", mac: "X" }, other);
  await db.insert(relations).values([
    { fromItemId: tvPlug, toItemId: tv, type: "powers", origin: "user", status: "confirmed" },
    { fromItemId: tvPlug, toItemId: macMini, type: "powers", origin: "user", status: "confirmed" },
  ]);
  return { houseId, other, fridgePlug, tvPlug, grid, solar, tv, macMini, elsewhere };
}

describe("energy.report", () => {
  it("upserts months by item and month, and writes no item event", async () => {
    const { houseId, fridgePlug } = await seedMeters();
    const c = callerFor(houseId);
    const before = (await getTestDb().select().from(events)).length;
    await c.energy.report({ itemId: fridgePlug, source: "plugwise", months: [{ month: "2025-01", kwhNormal: 10, kwhOffpeak: 5, baseW: 18.2, hours: 600 }] });
    await c.energy.report({ itemId: fridgePlug, source: "plugwise", months: [{ month: "2025-01", kwhNormal: 11, kwhOffpeak: 6, baseW: 18.4, hours: 744 }] });
    const rows = await getTestDb().select().from(energyMonths).where(eq(energyMonths.itemId, fridgePlug));
    expect(rows.map((r) => [r.month, Number(r.kwhNormal), Number(r.kwhOffpeak), Number(r.hours)])).toEqual([["2025-01", 11, 6, 744]]);
    expect((await getTestDb().select().from(events)).length).toBe(before);
  });

  it("refuses the whole report on any bad month", async () => {
    const { houseId, fridgePlug, grid, solar, tv } = await seedMeters();
    const c = callerFor(houseId);
    const bad = (itemId: number, months: object[]) => c.energy.report({ itemId, source: "t", months: months as never });
    await expect(bad(tv, [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow(/Not a meter/);
    await expect(bad(fridgePlug, [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1, kwhProduced: 2 }])).rejects.toThrow(/does not belong/);
    await expect(bad(grid, [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow(/kwhReturnedNormal is required/);
    await expect(bad(solar, [{ month: "2025-01", kwhNormal: 1 }])).rejects.toThrow(/kwhProduced is required/);
    await expect(bad(fridgePlug, [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1 }, { month: "2025-01", kwhNormal: 2, kwhOffpeak: 2 }])).rejects.toThrow(/twice/);
    await expect(bad(fridgePlug, [{ month: "2999-01", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow(/after the current month/);
    await expect(bad(fridgePlug, [{ month: "2025-13", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow(/not a month/);
    await expect(bad(fridgePlug, [{ month: "2025-01", kwhNormal: -0.01, kwhOffpeak: 1 }])).rejects.toThrow();
    await expect(bad(fridgePlug, [{ month: "25-1", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow();
    // nothing was written by any refused report, including the valid first month of the duplicate one
    expect(await getTestDb().select().from(energyMonths)).toEqual([]);
  });

  it("refuses an archived meter", async () => {
    const { houseId, fridgePlug } = await seedMeters();
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, fridgePlug));
    await expect(
      callerFor(houseId).energy.report({ itemId: fridgePlug, source: "t", months: [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1 }] }),
    ).rejects.toThrow(/archived/);
  });

  it("keeps the lib seam strict without zod in front of it", async () => {
    const { fridgePlug, grid, solar } = await seedMeters();
    const db = getTestDb() as never;
    const now = new Date(2026, 9, 4); // 4 Oct 2026, local time
    const plug = (months: object[]) => applyEnergyReport(db, { itemId: fridgePlug, source: "t", months: months as never }, now);
    await expect(plug([{ month: "25-1", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toBeInstanceOf(EnergyReportError);
    await expect(plug([{ month: "2025-01", kwhNormal: -1, kwhOffpeak: 1 }])).rejects.toThrow(/not a non-negative number/);
    await expect(plug([{ month: "2025-01", kwhNormal: Infinity, kwhOffpeak: 1 }])).rejects.toThrow(/not a non-negative number/);
    await expect(plug([{ month: "2025-01", kwhNormal: 1e8, kwhOffpeak: 1 }])).rejects.toThrow(/too large/);
    await expect(plug([{ month: "2026-11", kwhNormal: 1, kwhOffpeak: 1 }])).rejects.toThrow(/after the current month/);
    await expect(applyEnergyReport(db, { itemId: 999999, source: "t", months: [{ month: "2025-01" }] }, now)).rejects.toThrow(/not found/);
    expect(await getTestDb().select().from(energyMonths)).toEqual([]);
    // the current month itself is allowed (the collector sends the partial month)
    expect(await plug([{ month: "2026-10", kwhNormal: 1, kwhOffpeak: 0 }])).toEqual({ months: 1 });
    await applyEnergyReport(db, { itemId: grid, source: "dsmr", months: [{ month: "2026-09", kwhNormal: 1, kwhOffpeak: 2, kwhReturnedNormal: 3, kwhReturnedOffpeak: 4, hours: 720 }] }, now);
    await applyEnergyReport(db, { itemId: solar, source: "solaredge", months: [{ month: "2026-09", kwhProduced: 300.5 }] }, now);
    const rows = await getTestDb().select().from(energyMonths);
    expect(rows.length).toBe(3);
    const s = rows.find((r) => r.itemId === solar)!;
    expect([Number(s.kwhProduced), s.kwhNormal, s.source]).toEqual([300.5, null, "solaredge"]);
  });

  it("meterKind and currentMonth", () => {
    expect(meterKind({ attributes: { role: "meter", meter_kind: "grid" } })).toBe("grid");
    expect(meterKind({ attributes: { role: "meter", meter_kind: "gas" } })).toBeNull();
    expect(meterKind({ attributes: { meter_kind: "plug" } })).toBeNull();
    expect(meterKind({ attributes: null })).toBeNull();
    expect(currentMonth(new Date(2026, 0, 1, 0, 30))).toBe("2026-01");
    expect(currentMonth(new Date(2025, 11, 31, 23, 59))).toBe("2025-12");
  });
});
