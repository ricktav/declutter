import { eq } from "drizzle-orm";
import { energyMonths, items } from "@db/schema";
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
