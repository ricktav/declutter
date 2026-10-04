import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { areas, events, houses, items, relations, energyMonths, energyTariffs } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { EnergyReportError, applyEnergyReport, currentMonth, energyForItem, energyOverview, hoursIn, lastMonths, meterKind, tariffFor } from "../lib/energy";

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

  it("a refused report at the router is BAD_REQUEST", async () => {
    const { houseId, tv } = await seedMeters();
    await expect(callerFor(houseId).energy.report({ itemId: tv, source: "t", months: [{ month: "2025-01", kwhNormal: 1, kwhOffpeak: 1 }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("re-reporting a plug month without baseW leaves baseW NULL (replace semantics)", async () => {
    const { houseId, fridgePlug } = await seedMeters();
    const c = callerFor(houseId);
    await c.energy.report({ itemId: fridgePlug, source: "t", months: [{ month: "2025-01", kwhNormal: 10, kwhOffpeak: 5, baseW: 18.2 }] });
    await c.energy.report({ itemId: fridgePlug, source: "t", months: [{ month: "2025-01", kwhNormal: 10, kwhOffpeak: 5 }] });
    const [row] = await getTestDb().select().from(energyMonths).where(eq(energyMonths.itemId, fridgePlug));
    expect(row.baseW).toBeNull();
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

const NOW = new Date(2026, 9, 4, 12); // 4 Oct 2026, local time: last 12 = 2025-10..2026-09
const T = { validFrom: "2015-01-01", normal: 0.25, offpeak: 0.2, feedIn: 0.06, feedInCost: 0.04, fixedPerDay: 1.5, note: null };

describe("energy calculations", () => {
  it("windows are complete months, oldest first", () => {
    expect(lastMonths(3, NOW)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(lastMonths(12, NOW)[0]).toBe("2025-10");
    expect(lastMonths(2, new Date(2026, 0, 15))).toEqual(["2025-11", "2025-12"]);
    expect(hoursIn("2026-02")).toBe(28 * 24);
    expect(hoursIn("2028-02")).toBe(29 * 24);
  });
  it("picks the price valid on the month's first day", () => {
    const ts = [T, { ...T, validFrom: "2026-03-15", normal: 0.3 }];
    expect(tariffFor(ts, "2026-03")?.normal).toBe(0.25);
    expect(tariffFor(ts, "2026-04")?.normal).toBe(0.3);
    expect(tariffFor([{ ...T, validFrom: "2030-01-01" }], "2026-04")).toBeNull();
  });
});

describe("energy.overview", () => {
  async function fill() {
    const s = await seedMeters();
    const db = getTestDb();
    await db.delete(energyTariffs);
    await db.insert(energyTariffs).values({ validFrom: "2015-01-01", normalEurKwh: "0.25", offpeakEurKwh: "0.2", feedInEurKwh: "0.06", feedInCostEurKwh: "0.04", fixedEurDay: "1.5" });
    const year = lastMonths(24, NOW);
    const last = year.slice(12);
    // fridge: 10 + 5 kWh a month, full coverage; the second year uses 20% more
    const fridge = year.map((m, i) => {
      const f = i < 12 ? 1 : 1.2;
      return { month: m, kwhNormal: 10 * f, kwhOffpeak: 5 * f, baseW: 15 + i, peakW: 160, hours: hoursIn(m) };
    });
    // tv plug: only the last 12 months, 70% coverage -> no trend
    const tv = last.map((m) => ({ month: m, kwhNormal: 8, kwhOffpeak: 4, baseW: 30, peakW: 300, hours: hoursIn(m) * 0.7 }));
    // grid + solar for the last 12 months, except solar misses 2026-09
    const grid = last.map((m) => ({ month: m, kwhNormal: 100, kwhOffpeak: 80, kwhReturnedNormal: 50, kwhReturnedOffpeak: 10 }));
    const solar = last.filter((m) => m !== "2026-09").map((m) => ({ month: m, kwhProduced: 300 }));
    await applyEnergyReport(db, { itemId: s.fridgePlug, source: "t", months: fridge }, NOW);
    await applyEnergyReport(db, { itemId: s.tvPlug, source: "t", months: tv }, NOW);
    await applyEnergyReport(db, { itemId: s.grid, source: "t", months: grid }, NOW);
    await applyEnergyReport(db, { itemId: s.solar, source: "t", months: solar }, NOW);
    // the current, partial month is stored but never counted
    await applyEnergyReport(db, { itemId: s.fridgePlug, source: "t", months: [{ month: "2026-10", kwhNormal: 999, kwhOffpeak: 0 }] }, NOW);
    // a plug in another house never counts here
    await applyEnergyReport(db, { itemId: s.elsewhere, source: "t", months: [{ month: "2026-09", kwhNormal: 500, kwhOffpeak: 0 }] }, NOW);
    return s;
  }

  it("totals, costs, baseline and trend per plug over the last 12 complete months", async () => {
    const s = await fill();
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    expect(o.months[0]).toBe("2025-10");
    expect(o.months[11]).toBe("2026-09");
    expect(o.tariff?.normal).toBe(0.25);
    const fridge = o.plugs.find((p) => p.itemId === s.fridgePlug)!;
    expect(fridge.kwh).toBeCloseTo(12 * 15 * 1.2, 3);
    expect(fridge.eur).toBeCloseTo(12 * (12 * 0.25 + 6 * 0.2), 3);
    expect(fridge.trendPct).toBeCloseTo(20, 1);
    expect(fridge.baseW).toBe(32.5); // median of 27..38
    expect(fridge.peakW).toBe(160);
    expect(fridge.baseEurYear).toBeCloseTo((32.5 / 1000) * 8760 * ((80 / 168) * 0.25 + (88 / 168) * 0.2), 2);
    expect(fridge.hours).toBe(fridge.hoursPossible);
    const tv = o.plugs.find((p) => p.itemId === s.tvPlug)!;
    expect(tv.trendPct).toBeNull(); // 70% coverage and no previous year
    expect(tv.powers.map((p) => p.name).sort()).toEqual(["Mac mini", "Television"]);
    expect(fridge.powers).toEqual([]);
    expect(o.plugs.map((p) => p.itemId)).not.toContain(s.elsewhere);
    expect(o.plugs.map((p) => p.itemId)).not.toContain(s.grid);
    expect(o.plugs[0].itemId).toBe(s.fridgePlug); // sorted by euros, highest first
    expect(o.rooms).toEqual([{ roomId: null, name: "No room", kwh: 12 * 18 + 12 * 12, eur: expect.closeTo(12 * 4.2 + 12 * 2.8, 2) }]);
    expect(o.house.baselineW).toBe(62.5);
  });

  it("house use only counts months that have every source", async () => {
    const s = await fill();
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    expect(o.house.monthsCounted).toBe(11); // 2026-09 has no solar row
    expect(o.house.useKwh).toBeCloseTo(11 * (180 + 300 - 60), 3);
    expect(o.house.producedKwh).toBeCloseTo(11 * 300, 3);
    expect(o.house.exportKwh).toBeCloseTo(11 * 60, 3);
    const plugs11 = 11 * (15 * 1.2 + 12);
    expect(o.house.unmeasuredKwh).toBeCloseTo(11 * (180 + 300 - 60) - plugs11, 3);
    expect(o.house.importKwh).toBeCloseTo(11 * 180, 3);
    // fixed costs only for the 11 counted months (2025-10 .. 2026-08: 335 days)
    expect(o.house.fixedEur).toBeCloseTo(335 * 1.5, 2);
    expect(o.house.netCostEur).toBeCloseTo(11 * (100 * 0.25 + 80 * 0.2 - 60 * (0.06 - 0.04)) + o.house.fixedEur!, 2);
  });

  it("a month with solar and plug rows but no grid row is not counted and unmeasured never goes negative", async () => {
    const s = await seedMeters();
    const db = getTestDb();
    await applyEnergyReport(db, { itemId: s.grid, source: "t", months: [{ month: "2026-08", kwhNormal: 100, kwhOffpeak: 50, kwhReturnedNormal: 0, kwhReturnedOffpeak: 0 }] }, NOW);
    await applyEnergyReport(db, { itemId: s.solar, source: "t", months: [{ month: "2026-08", kwhProduced: 10 }, { month: "2026-09", kwhProduced: 500 }] }, NOW);
    await applyEnergyReport(db, { itemId: s.fridgePlug, source: "t", months: [{ month: "2026-08", kwhNormal: 5, kwhOffpeak: 5 }, { month: "2026-09", kwhNormal: 400, kwhOffpeak: 400 }] }, NOW);
    const o = await energyOverview(db, s.houseId, NOW);
    expect(o.house.monthsCounted).toBe(1); // only 2026-08 has a grid row
    expect(o.house.useKwh).toBeCloseTo(160, 3);
    expect(o.house.unmeasuredKwh!).toBeGreaterThanOrEqual(0);
    expect(o.house.unmeasuredKwh).toBeCloseTo(150, 3);
  });

  it("gives null house figures and euros when nothing can be counted or priced", async () => {
    const s = await seedMeters();
    await getTestDb().delete(energyTariffs);
    await applyEnergyReport(getTestDb(), { itemId: s.fridgePlug, source: "t", months: [{ month: "2026-09", kwhNormal: 1, kwhOffpeak: 1 }] }, NOW);
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    expect(o.tariff).toBeNull();
    expect(o.house).toMatchObject({ useKwh: null, unmeasuredKwh: null, netCostEur: null, monthsCounted: 0, baselineEurYear: null });
    const fridge = o.plugs.find((p) => p.itemId === s.fridgePlug)!;
    expect([fridge.kwh, fridge.eur, fridge.avgW, fridge.trendPct]).toEqual([2, null, null, null]);
  });

  it("leaves out archived meters", async () => {
    const s = await fill();
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, s.tvPlug));
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    expect(o.plugs.map((p) => p.itemId)).toEqual([s.fridgePlug]);
  });

  it("is scoped to the session house through the router", async () => {
    const s = await fill();
    const o = await callerFor(s.other).energy.overview({});
    expect(o.plugs.map((p) => p.itemId)).toEqual([s.elsewhere]);
    const all = await callerFor(s.other).energy.overview({ houseId: null });
    expect(all.plugs.map((p) => p.itemId).sort((a, b) => a - b)).toEqual([s.fridgePlug, s.tvPlug, s.elsewhere].sort((a, b) => a - b));
  });

  it("with houseId null, the house block is the one house that has a grid meter", async () => {
    const s = await fill();
    // a counted month for the other house's plug: it must not lower this house's "not measured"
    await applyEnergyReport(getTestDb(), { itemId: s.elsewhere, source: "t", months: [{ month: "2026-08", kwhNormal: 40, kwhOffpeak: 0 }] }, NOW);
    const scoped = await energyOverview(getTestDb(), s.houseId, NOW);
    const all = await energyOverview(getTestDb(), null, NOW);
    expect(all.house).toEqual(scoped.house);
    expect(all.plugs.map((p) => p.itemId)).toContain(s.elsewhere);
  });

  it("with houseId null and two houses with a grid meter, the house block is empty", async () => {
    const s = await fill();
    const db = getTestDb();
    const [{ areaId }] = await db.select({ areaId: items.areaId }).from(items).where(eq(items.id, s.grid));
    const [{ id: grid2 }] = await db.insert(items).values({ areaId, houseId: s.other, name: "Slimme meter Josies", attributes: { role: "meter", meter_kind: "grid" } }).$returningId();
    await applyEnergyReport(db, { itemId: grid2, source: "t", months: [{ month: "2026-08", kwhNormal: 1, kwhOffpeak: 1, kwhReturnedNormal: 0, kwhReturnedOffpeak: 0 }] }, NOW);
    const all = await energyOverview(db, null, NOW);
    expect(all.house).toMatchObject({ useKwh: null, producedKwh: null, importKwh: null, exportKwh: null, unmeasuredKwh: null, netCostEur: null, fixedEur: null, monthsCounted: 0 });
    expect(all.house.baselineW).toBe(0); // the block is empty, so are its plugs
    const one = await energyOverview(db, s.houseId, NOW);
    expect(one.house.monthsCounted).toBe(11);
    expect(one.house.baselineW).toBe(62.5); // the block house's plugs only
  });
});

describe("energy.forItem and setTariff", () => {
  it("gives a powered item its plug's figures and the other items on that plug", async () => {
    const s = await seedMeters();
    const db = getTestDb();
    await applyEnergyReport(db, { itemId: s.tvPlug, source: "t", months: [{ month: "2026-09", kwhNormal: 8, kwhOffpeak: 4, hours: 720 }] }, NOW);
    const e = (await energyForItem(db, s.tv, NOW))!;
    expect(e.plug).toEqual({ id: s.tvPlug, name: "Plugwise – TV / Mac / UPC" });
    expect(e.sharedWith.map((x) => x.name)).toEqual(["Mac mini"]);
    expect(e.months).toHaveLength(24);
    expect(e.months.at(-1)).toMatchObject({ month: "2026-09", kwh: 12, hours: 720 });
    expect(e.summary?.kwh).toBe(12);
    const plug = (await energyForItem(db, s.tvPlug, NOW))!;
    expect(plug.sharedWith.map((x) => x.name).sort()).toEqual(["Mac mini", "Television"]);
  });

  it("gives a plug with no months a null summary and 24 empty months, not an empty card", async () => {
    const s = await seedMeters();
    const e = (await energyForItem(getTestDb(), s.fridgePlug, NOW))!;
    expect(e.plug).toEqual({ id: s.fridgePlug, name: "Plugwise – Koelkast" });
    expect(e.summary).toBeNull();
    expect(e.months).toHaveLength(24);
    expect(e.months.every((m) => m.kwh == null && m.hoursPossible > 0)).toBe(true);
  });

  it("returns an empty result for an item without a plug and NOT_FOUND for a missing id", async () => {
    const s = await seedMeters();
    const c = callerFor(s.houseId);
    expect(await c.energy.forItem({ itemId: s.grid })).toEqual({ plug: null, sharedWith: [], summary: null, months: [] });
    await expect(c.energy.forItem({ itemId: 999999 })).rejects.toThrow(/not found/i);
  });

  it("setTariff upserts by validFrom and logs an event", async () => {
    const s = await seedMeters();
    const c = callerFor(s.houseId);
    const before = (await getTestDb().select().from(events)).length;
    await c.energy.setTariff({ validFrom: "2027-01-01", normal: 0.3, offpeak: 0.25, feedIn: 0.05, feedInCost: 0.04, fixedPerDay: 1.6 });
    await c.energy.setTariff({ validFrom: "2027-01-01", normal: 0.31, offpeak: 0.25, feedIn: 0.05, feedInCost: 0.04, fixedPerDay: 1.6, note: "new contract" });
    const rows = await getTestDb().select().from(energyTariffs);
    expect(rows.filter((r) => String(r.validFrom) === "2027-01-01").map((r) => [Number(r.normalEurKwh), r.note])).toEqual([[0.31, "new contract"]]);
    expect((await getTestDb().select().from(events)).length).toBe(before + 2);
  });

  it("setTariff refuses negative prices and dates that are not YYYY-MM-DD", async () => {
    const s = await seedMeters();
    const c = callerFor(s.houseId);
    const ok = { validFrom: "2027-01-01", normal: 0.3, offpeak: 0.25, feedIn: 0.05, feedInCost: 0.04, fixedPerDay: 1.6 };
    await expect(c.energy.setTariff({ ...ok, normal: -0.1 })).rejects.toThrow();
    await expect(c.energy.setTariff({ ...ok, validFrom: "2027-1-1" })).rejects.toThrow();
    await expect(c.energy.setTariff({ ...ok, validFrom: "2027-02-30" })).rejects.toThrow();
    await expect(c.energy.setTariff({ ...ok, normal: 100 })).rejects.toThrow();
    expect(await getTestDb().select().from(energyTariffs)).toHaveLength(0);
  });
});
