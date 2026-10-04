import { and, eq, inArray } from "drizzle-orm";
import { energyMonths, energyTariffs, items, relations, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

export const METER_KINDS = ["plug", "grid", "solar"] as const;
export type MeterKind = (typeof METER_KINDS)[number];
/** relation type: fromItemId (a plug) powers toItemId (an appliance) */
export const POWERS = "powers";

export class EnergyReportError extends Error {}

export type ReportMonth = {
  month: string;
  kwhNormal?: number;
  kwhOffpeak?: number;
  kwhReturnedNormal?: number;
  kwhReturnedOffpeak?: number;
  kwhProduced?: number;
  avgW?: number;
  baseW?: number;
  peakW?: number;
  hours?: number;
};
type NumberField = Exclude<keyof ReportMonth, "month">;
const NUMBER_FIELDS: NumberField[] = ["kwhNormal", "kwhOffpeak", "kwhReturnedNormal", "kwhReturnedOffpeak", "kwhProduced", "avgW", "baseW", "peakW", "hours"];

/** The largest value each decimal column holds (db/schema.ts energyMonths), so an overflow is a clear refusal, not a SQL error. */
const MAX: Record<NumberField, number> = {
  kwhNormal: 9_999_999.999,
  kwhOffpeak: 9_999_999.999,
  kwhReturnedNormal: 9_999_999.999,
  kwhReturnedOffpeak: 9_999_999.999,
  kwhProduced: 9_999_999.999,
  avgW: 9_999_999.9,
  baseW: 9_999_999.9,
  peakW: 9_999_999.9,
  hours: 99_999.9,
};

/** Which fields each kind of meter must and may send. Anything else is refused. */
const FIELDS: Record<MeterKind, { required: NumberField[]; optional: NumberField[] }> = {
  plug: { required: ["kwhNormal", "kwhOffpeak"], optional: ["avgW", "baseW", "peakW", "hours"] },
  grid: { required: ["kwhNormal", "kwhOffpeak", "kwhReturnedNormal", "kwhReturnedOffpeak"], optional: ["hours"] },
  solar: { required: ["kwhProduced"], optional: ["hours"] },
};

export function meterKind(item: { attributes: Record<string, string | number> | null }): MeterKind | null {
  if (item.attributes?.role !== "meter") return null;
  const k = item.attributes?.meter_kind;
  return (METER_KINDS as readonly unknown[]).includes(k) ? (k as MeterKind) : null;
}

/** This month as YYYY-MM in local time. */
export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Check every month of a report before anything is written. The router's zod
 * schema checks shape and sign too; these checks repeat them so the lib seam
 * is safe for callers that skip zod (tests, scripts).
 */
export function checkMonths(kind: MeterKind, months: ReportMonth[], now = new Date()): void {
  const cur = currentMonth(now);
  const { required, optional } = FIELDS[kind];
  const allowed = new Set<NumberField>([...required, ...optional]);
  const seen = new Set<string>();
  for (const m of months) {
    if (typeof m.month !== "string" || !/^\d{4}-\d{2}$/.test(m.month)) throw new EnergyReportError(`${String(m.month)}: not a month (YYYY-MM).`);
    const mm = Number(m.month.slice(5));
    if (mm < 1 || mm > 12) throw new EnergyReportError(`${m.month}: not a month.`);
    if (seen.has(m.month)) throw new EnergyReportError(`${m.month}: the month appears twice in this report.`);
    seen.add(m.month);
    if (m.month > cur) throw new EnergyReportError(`${m.month}: after the current month (${cur}).`);
    for (const f of required) if (m[f] == null) throw new EnergyReportError(`${m.month}: ${f} is required for a ${kind} meter.`);
    for (const f of NUMBER_FIELDS) {
      const v = m[f];
      if (v == null) continue;
      if (!allowed.has(f)) throw new EnergyReportError(`${m.month}: ${f} does not belong to a ${kind} meter.`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new EnergyReportError(`${m.month}: ${f} is not a non-negative number.`);
      if (v > MAX[f]) throw new EnergyReportError(`${m.month}: ${f} is too large (max ${MAX[f]}).`);
    }
  }
}

// toFixed avoids exponent notation (1e-7) in the decimal string; the column scale rounds the rest.
const dec = (v: number | undefined) => (v == null ? null : v.toFixed(6));

/**
 * Upsert one meter's months, keyed by (itemId, month), in one transaction.
 * The meter must be an active item with role "meter" and a known meter_kind.
 * A re-reported month replaces the whole row: a field left out becomes NULL (it is not kept from an earlier report).
 * Never deletes; writes no item event (a report is a measurement, not an edit).
 */
export async function applyEnergyReport(db: Db, input: { itemId: number; source: string; months: ReportMonth[] }, now = new Date()): Promise<{ months: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new EnergyReportError("Item not found.");
  if (item.status !== "active") throw new EnergyReportError("Item is archived: a report needs an active meter.");
  const kind = meterKind(item);
  if (!kind) throw new EnergyReportError('Not a meter: the item needs role "meter" and meter_kind plug, grid or solar.');
  checkMonths(kind, input.months, now);
  await db.transaction(async (tx) => {
    for (const m of input.months) {
      const set = {
        kwhNormal: dec(m.kwhNormal),
        kwhOffpeak: dec(m.kwhOffpeak),
        kwhReturnedNormal: dec(m.kwhReturnedNormal),
        kwhReturnedOffpeak: dec(m.kwhReturnedOffpeak),
        kwhProduced: dec(m.kwhProduced),
        avgW: dec(m.avgW),
        baseW: dec(m.baseW),
        peakW: dec(m.peakW),
        hours: dec(m.hours),
        source: input.source,
        measuredAt: now,
      };
      await tx.insert(energyMonths).values({ itemId: input.itemId, month: m.month, ...set }).onDuplicateKeyUpdate({ set });
    }
  });
  return { months: input.months.length };
}

// ---------------------------------------------------------------------------
// Calculations (spec §4). Decimal columns arrive as strings; they become numbers here.

export type Tariff = { validFrom: string; normal: number; offpeak: number; feedIn: number; feedInCost: number; fixedPerDay: number; note: string | null };
type Month = {
  month: string;
  kwhNormal: number | null;
  kwhOffpeak: number | null;
  kwhReturnedNormal: number | null;
  kwhReturnedOffpeak: number | null;
  kwhProduced: number | null;
  avgW: number | null;
  baseW: number | null;
  peakW: number | null;
  hours: number | null;
};

const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));
const toMonth = (r: typeof energyMonths.$inferSelect): Month => ({
  month: r.month,
  kwhNormal: num(r.kwhNormal),
  kwhOffpeak: num(r.kwhOffpeak),
  kwhReturnedNormal: num(r.kwhReturnedNormal),
  kwhReturnedOffpeak: num(r.kwhReturnedOffpeak),
  kwhProduced: num(r.kwhProduced),
  avgW: num(r.avgW),
  baseW: num(r.baseW),
  peakW: num(r.peakW),
  hours: num(r.hours),
});

export async function loadTariffs(db: Db): Promise<Tariff[]> {
  const rows = await db.select().from(energyTariffs).orderBy(energyTariffs.validFrom);
  return rows.map((r) => ({
    validFrom: String(r.validFrom),
    normal: Number(r.normalEurKwh),
    offpeak: Number(r.offpeakEurKwh),
    feedIn: Number(r.feedInEurKwh),
    feedInCost: Number(r.feedInCostEurKwh),
    fixedPerDay: Number(r.fixedEurDay),
    note: r.note,
  }));
}

/** The price valid on the month's first day: the latest validFrom on or before it. */
export function tariffFor(tariffs: Tariff[], month: string): Tariff | null {
  const first = `${month}-01`;
  let found: Tariff | null = null;
  for (const t of [...tariffs].sort((a, b) => a.validFrom.localeCompare(b.validFrom))) if (t.validFrom <= first) found = t;
  return found;
}

/** The n complete months before the current one, oldest first. */
export function lastMonths(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n; i >= 1; i--) out.push(currentMonth(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return out;
}
export function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
export const hoursIn = (month: string) => daysIn(month) * 24;

/** 88 of the week's 168 hours are off-peak (weekdays 23-07, weekends). */
const OFFPEAK_SHARE = 88 / 168;
const used = (m: Month) => (m.kwhNormal ?? 0) + (m.kwhOffpeak ?? 0);
const cost = (m: Month, t: Tariff | null) => (t ? (m.kwhNormal ?? 0) * t.normal + (m.kwhOffpeak ?? 0) * t.offpeak : null);
export const baselineEurYear = (baseW: number | null, t: Tariff | null) =>
  baseW == null || !t ? null : (baseW / 1000) * 8760 * ((1 - OFFPEAK_SHARE) * t.normal + OFFPEAK_SHARE * t.offpeak);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (v: number | null, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Sums over a window of months; months without a row add nothing. */
function windowStats(rows: Map<string, Month>, window: string[], tariffs: Tariff[]) {
  let kwh = 0,
    eur = 0,
    hours = 0,
    priced = true;
  const bases: number[] = [];
  let peak: number | null = null;
  let any = false;
  for (const m of window) {
    const r = rows.get(m);
    if (!r) continue;
    any = true;
    kwh += used(r);
    const c = cost(r, tariffFor(tariffs, m));
    if (c == null) priced = false;
    else eur += c;
    hours += r.hours ?? 0;
    if (r.baseW != null) bases.push(r.baseW);
    if (r.peakW != null) peak = Math.max(peak ?? 0, r.peakW);
  }
  const hoursPossible = window.reduce((s, m) => s + hoursIn(m), 0);
  return { any, kwh, eur: priced ? eur : null, hours, hoursPossible, baseW: median(bases), peakW: peak };
}

/** Last 12 months against the 12 before, in percent; null unless both windows are ≥ 80% measured. */
export const TREND_FLOOR_KWH = 5;

function trend(rows: Map<string, Month>, now: Date, tariffs: Tariff[]): number | null {
  const all = lastMonths(24, now);
  const prev = windowStats(rows, all.slice(0, 12), tariffs);
  const last = windowStats(rows, all.slice(12), tariffs);
  // a previous year under TREND_FLOOR_KWH (an idle plug, a few Wh) is no base for a percentage
  if (prev.hours < 0.8 * prev.hoursPossible || last.hours < 0.8 * last.hoursPossible || prev.kwh < TREND_FLOOR_KWH) return null;
  return round(((last.kwh - prev.kwh) / prev.kwh) * 100);
}

export type PlugSummary = {
  itemId: number;
  name: string;
  roomId: number | null;
  roomName: string | null;
  kwh: number;
  eur: number | null;
  avgW: number | null;
  baseW: number | null;
  baseEurYear: number | null;
  peakW: number | null;
  hours: number;
  hoursPossible: number;
  trendPct: number | null;
  powers: { id: number; name: string }[];
};
export type EnergyOverview = {
  months: string[];
  tariff: Tariff | null;
  house: {
    useKwh: number | null;
    producedKwh: number | null;
    importKwh: number | null;
    exportKwh: number | null;
    unmeasuredKwh: number | null;
    netCostEur: number | null;
    fixedEur: number | null;
    monthsCounted: number;
    baselineW: number;
    baselineEurYear: number | null;
  };
  plugs: PlugSummary[];
  rooms: { roomId: number | null; name: string; kwh: number; eur: number | null }[];
};

/** Active meter items, of one house or (houseId null) of all houses. */
async function metersOf(db: Db, houseId: number | null) {
  const where = houseId != null ? and(eq(items.status, "active"), eq(items.houseId, houseId)) : eq(items.status, "active");
  const all = await db.select({ id: items.id, name: items.name, houseId: items.houseId, roomId: items.roomId, attributes: items.attributes }).from(items).where(where);
  return all.flatMap((i) => {
    const kind = meterKind(i);
    return kind ? [{ id: i.id, name: i.name, houseId: i.houseId, roomId: i.roomId, kind }] : [];
  });
}

async function monthsByItem(db: Db, itemIds: number[], window: string[]) {
  const by = new Map<number, Map<string, Month>>();
  if (itemIds.length === 0) return by;
  const rows = await db.select().from(energyMonths).where(and(inArray(energyMonths.itemId, itemIds), inArray(energyMonths.month, window)));
  for (const r of rows) {
    if (!by.has(r.itemId)) by.set(r.itemId, new Map());
    by.get(r.itemId)!.set(r.month, toMonth(r));
  }
  return by;
}

/** The active items each plug powers. */
async function poweredBy(db: Db, plugIds: number[]) {
  const out = new Map<number, { id: number; name: string }[]>();
  if (plugIds.length === 0) return out;
  const rels = await db
    .select({ from: relations.fromItemId, id: items.id, name: items.name })
    .from(relations)
    .innerJoin(items, eq(items.id, relations.toItemId))
    .where(and(eq(relations.type, POWERS), inArray(relations.fromItemId, plugIds), eq(items.status, "active")));
  for (const r of rels) out.set(r.from, [...(out.get(r.from) ?? []), { id: r.id, name: r.name }]);
  return out;
}

/**
 * The last 12 complete months for one house (or all houses when houseId is null):
 * per plug, per room, and the house from its grid meter and inverter.
 * The current, partial month never counts. A house month counts only when the
 * grid meter and (if the house has one) the inverter both have a row for it.
 * The house block always describes one house: its grid meter, inverter and plugs.
 * With houseId null the plug and room lists cover all houses, and the block is
 * the one house that has a grid meter; with two or more such houses there is no
 * single house to describe, so the block stays empty (null figures, 0 months).
 */
export async function energyOverview(db: Db, houseId: number | null, now = new Date()): Promise<EnergyOverview> {
  const months = lastMonths(12, now);
  const window24 = lastMonths(24, now);
  const tariffs = await loadTariffs(db);
  const tariff = tariffFor(tariffs, currentMonth(now));
  const meters = await metersOf(db, houseId);
  const data = await monthsByItem(
    db,
    meters.map((m) => m.id),
    window24,
  );
  const plugMeters = meters.filter((m) => m.kind === "plug");
  const links = await poweredBy(
    db,
    plugMeters.map((p) => p.id),
  );
  const roomIds = [...new Set(plugMeters.map((p) => p.roomId).filter((r): r is number => r != null))];
  const roomNames = new Map(
    roomIds.length ? (await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(inArray(rooms.id, roomIds))).map((r) => [r.id, r.name]) : [],
  );

  const plugs: PlugSummary[] = plugMeters.map((p) => {
    const rows = data.get(p.id) ?? new Map<string, Month>();
    const w = windowStats(rows, months, tariffs);
    return {
      itemId: p.id,
      name: p.name,
      roomId: p.roomId,
      roomName: p.roomId != null ? (roomNames.get(p.roomId) ?? null) : null,
      kwh: round(w.kwh, 3)!,
      eur: round(w.eur, 2),
      avgW: w.hours > 0 ? round((w.kwh * 1000) / w.hours) : null,
      baseW: round(w.baseW),
      baseEurYear: round(baselineEurYear(w.baseW, tariff), 2),
      peakW: round(w.peakW),
      hours: round(w.hours)!,
      hoursPossible: w.hoursPossible,
      trendPct: trend(rows, now, tariffs),
      powers: links.get(p.id) ?? [],
    };
  });
  plugs.sort((a, b) => (b.eur ?? b.kwh) - (a.eur ?? a.kwh));

  const roomTotals = new Map<number | null, { roomId: number | null; name: string; kwh: number; eur: number | null }>();
  for (const p of plugs) {
    const r = roomTotals.get(p.roomId) ?? { roomId: p.roomId, name: p.roomName ?? "No room", kwh: 0, eur: 0 };
    r.kwh = round(r.kwh + p.kwh, 3)!;
    r.eur = r.eur == null || p.eur == null ? null : round(r.eur + p.eur, 2);
    roomTotals.set(p.roomId, r);
  }

  // house: one house's meters only; only months where its grid meter and (if there is one) its inverter both have a row
  const gridHouses = [...new Set(meters.filter((m) => m.kind === "grid").map((m) => m.houseId))];
  const blockMeters = gridHouses.length === 1 ? meters.filter((m) => m.houseId === gridHouses[0]) : [];
  const grid = blockMeters.find((m) => m.kind === "grid");
  const solar = blockMeters.find((m) => m.kind === "solar");
  const blockPlugs = blockMeters.filter((m) => m.kind === "plug");
  let useKwh = 0,
    producedKwh = 0,
    importKwh = 0,
    exportKwh = 0,
    unmeasured = 0,
    netCost = 0,
    fixed = 0,
    counted = 0,
    priced = true;
  for (const m of months) {
    const g = grid ? data.get(grid.id)?.get(m) : undefined;
    const s = solar ? data.get(solar.id)?.get(m) : undefined;
    if (!g || (solar && !s)) continue;
    const t = tariffFor(tariffs, m);
    const imp = used(g);
    const exp = (g.kwhReturnedNormal ?? 0) + (g.kwhReturnedOffpeak ?? 0);
    const prod = s?.kwhProduced ?? 0;
    const use = imp + prod - exp;
    // Known simplification: a plug without a row for this month counts as 0 in the plug sum,
    // so a plug that missed a month makes "not measured" larger, never smaller.
    const plugSum = blockPlugs.reduce((sum, p) => {
      const r = data.get(p.id)?.get(m);
      return sum + (r ? used(r) : 0);
    }, 0);
    counted++;
    useKwh += use;
    producedKwh += prod;
    importKwh += imp;
    exportKwh += exp;
    unmeasured += use - plugSum;
    if (!t) priced = false;
    else {
      const f = t.fixedPerDay * daysIn(m);
      fixed += f;
      netCost += cost(g, t)! - exp * (t.feedIn - t.feedInCost) + f;
    }
  }
  // the house baseline is the house block's plugs only, so it matches the other house figures
  const blockPlugIds = new Set(blockPlugs.map((p) => p.id));
  const baselineW = plugs.filter((p) => blockPlugIds.has(p.itemId)).reduce((s, p) => s + (p.baseW ?? 0), 0);
  return {
    months,
    tariff,
    house: {
      useKwh: counted ? round(useKwh, 3) : null,
      producedKwh: counted && solar ? round(producedKwh, 3) : null,
      importKwh: counted ? round(importKwh, 3) : null,
      exportKwh: counted ? round(exportKwh, 3) : null,
      unmeasuredKwh: counted ? round(unmeasured, 3) : null,
      netCostEur: counted && priced ? round(netCost, 2) : null,
      fixedEur: counted && priced ? round(fixed, 2) : null,
      monthsCounted: counted,
      baselineW: round(baselineW)!,
      baselineEurYear: round(baselineEurYear(baselineW, tariff), 2),
    },
    plugs,
    rooms: [...roomTotals.values()].sort((a, b) => b.kwh - a.kwh),
  };
}

export type ItemEnergy = {
  plug: { id: number; name: string } | null;
  sharedWith: { id: number; name: string }[];
  summary: { kwh: number; eur: number | null; baseW: number | null; peakW: number | null; hours: number; hoursPossible: number; trendPct: number | null } | null;
  months: { month: string; kwh: number | null; eur: number | null; hours: number | null; hoursPossible: number }[];
};

/**
 * A plug's figures for the plug itself or for an item it powers: the last 12
 * complete months as a summary and the last 24 month by month. The whole
 * plug's use is shown, with the other items on it; it is never split.
 * Null when the item does not exist; an empty result when no plug is involved.
 */
export async function energyForItem(db: Db, itemId: number, now = new Date()): Promise<ItemEnergy | null> {
  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) return null;
  let plug: { id: number; name: string } | null = meterKind(item) === "plug" ? { id: item.id, name: item.name } : null;
  if (!plug) {
    const rels = await db
      .select({ id: items.id, name: items.name, attributes: items.attributes })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.fromItemId))
      .where(and(eq(relations.type, POWERS), eq(relations.toItemId, itemId), eq(items.status, "active")))
      .orderBy(items.id);
    // only a plug meter counts as the source; a stray powers link from something else does not
    const rel = rels.find((r) => meterKind(r) === "plug");
    plug = rel ? { id: rel.id, name: rel.name } : null;
  }
  if (!plug) return { plug: null, sharedWith: [], summary: null, months: [] };
  const sharedWith = ((await poweredBy(db, [plug.id])).get(plug.id) ?? []).filter((x) => x.id !== itemId);
  const window24 = lastMonths(24, now);
  const tariffs = await loadTariffs(db);
  const rows = (await monthsByItem(db, [plug.id], window24)).get(plug.id) ?? new Map<string, Month>();
  const w = windowStats(rows, window24.slice(12), tariffs);
  return {
    plug,
    sharedWith,
    summary: w.any
      ? {
          kwh: round(w.kwh, 3)!,
          eur: round(w.eur, 2),
          baseW: round(w.baseW),
          peakW: round(w.peakW),
          hours: round(w.hours)!,
          hoursPossible: w.hoursPossible,
          trendPct: trend(rows, now, tariffs),
        }
      : null,
    months: window24.map((m) => {
      const r = rows.get(m);
      return { month: m, kwh: r ? round(used(r), 3) : null, eur: r ? round(cost(r, tariffFor(tariffs, m)), 2) : null, hours: r?.hours ?? null, hoursPossible: hoursIn(m) };
    }),
  };
}
