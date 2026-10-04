# Energy Lens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Energy use and cost per appliance, per room and for the whole house, in a Flow lens. The figures come from monthly figures per meter that collectors send to HomeBase.

**Architecture:**
- **Store:** two new tables, `energy_months` and `energy_tariffs`, with an `energy` tRPC router. All calculations live in `api/lib/energy.ts` and are tested there, so the screens only render.
- **Collectors:** two Python collectors on dockermac-1 send monthly figures through `energy.report`. One reads the Plugwise history DB; the other reads DSMR-reader and SolarEdge.
- **Setup:** a one-off script creates rooms, meter items and `powers` links through the existing item and room procedures.
- **Screens:** the Flow "⚡ Energy" lens and a Workbench section read `energy.overview` and `energy.forItem`.

**Tech Stack:** TypeScript, tRPC 11, Drizzle (MySQL), zod, vitest (api tests on TEST_DATABASE_URL), React + Tailwind (Flow, Workbench), Python 3 standard library (collectors), Node 22 `fetch` (setup script).

**Spec:** `docs/superpowers/specs/2026-10-04-energy-lens-design.md`

## Global Constraints

- **Columns:** camelCase; `itemId` is `bigint unsigned` (mode number) with no declared FK; each table has a serial `id` plus a unique index. The migration is 0009.
- **Decimals:** decimal columns come back from Drizzle as strings. `api/lib/energy.ts` converts them to numbers; readers only ever see numbers.
- **Numbers in:** every number into `energy.report` is zod `number().nonnegative().finite()`. `month` matches `^\d{4}-\d{2}$`, local time, and is not after the current month.
- **Report writes:** `energy.report` writes no item event, and `energy.setTariff` does log one. Reports never delete.
- **Off-peak hours:** Monday–Friday 23:00–07:00, and Saturday and Sunday all day. Public holidays are ignored.
- **Months:** "Last 12 months" means the 12 complete months before the current one. The trend needs ≥ 80% coverage in both windows.
- **Baseline:** `baseW` is the 10th percentile of the month's 15-minute averages. Baseline €/yr = `baseW`/1000 × 8760 × (80/168 × normal + 88/168 × off-peak).
- **Seed tariff:** validFrom 2015-01-01; normal and off-peak 0.24395; feed-in 0.06050; feed-in cost 0.03993; fixed 1.510 €/day; note "contract prices 2026; older prices unknown".
- **Meter fields per `meter_kind`:**
  - plug: requires `kwhNormal`, `kwhOffpeak`; may carry `avgW`, `baseW`, `peakW`, `hours`.
  - grid: requires `kwhNormal`, `kwhOffpeak`, `kwhReturnedNormal`, `kwhReturnedOffpeak`; may carry `hours`.
  - solar: requires `kwhProduced`; may carry `hours`.
  - Anything else is refused.
- **Grid counters:** `kwhNormal` = DSMR `electricity2` (T2), `kwhOffpeak` = `electricity1` (T1). Export is the same with `_returned`.
- **HomeBase for collectors and setup:** `http://10.50.0.102:3001`. Secrets are read at runtime from `~/html/api/dsmr.php` (DSMR token) and `~/tesla/.env` (`SOLAREDGE_API_KEY`) on dockermac-1, never copied or printed. SolarEdge site is 181945.
- **Tests:** never against DATABASE_URL (AGENTS.md); router tests use TEST_DATABASE_URL.
- **Data history:** DSMR-reader day statistics start 2020-07-14 (checked 4 Oct 2026); SolarEdge from 2015-10-28; Plugwise history from 2020.

## Review Focus

1. **A month in progress.** The current month is partial. Overview totals use only complete months; the collector still sends the current month so the card's 24-month line shows it.
2. **A plug that reports small negative watts** (Plugwise shows −0.0x on idle plugs). The collector clamps at 0 before sending, because the contract refuses negatives.
3. **Shared and unlinked plugs.** An appliance on a plug shows the whole plug's use with "shared with …". It must not show an empty card or split the use. A plug with no links shows "Powers…" and still counts in the top lists.
4. **House months with one source missing** (DSMR before 2020-07, a SolarEdge outage). That month is left out of house use and "Not on a plug". It must not count as zero or negative.
5. **Re-running the setup or the collectors.** Both must be no-ops the second time: no duplicate rooms, items or `powers` links, and the same `energy_months` rows.

Tests pinning these: Task 2 step 1 (negatives refused), Task 3 step 1 (partial month excluded, missing source skipped), Task 4 step 1 (shared plug), Task 6 step 4 (setup rerun), Task 7 step 1 (negative clamp).

---

## Part I — declutter-main (database, API, Workbench)

### Task 1: Tables, migration 0009 and the seed tariff

**Files:**
- Modify: `db/schema.ts` (add `decimal`, `char`, `date` imports; add `energyMonths`, `energyTariffs` after the storage tables)
- Create: `db/migrations/0009_energy.sql` (via `npm run db:generate`, then add the seed insert)
- Test: `api/test/energy.test.ts`

**Interfaces:**
- Produces: `energyMonths`, `energyTariffs` tables (Drizzle), with types `EnergyMonthRow = typeof energyMonths.$inferSelect` and `EnergyTariffRow = typeof energyTariffs.$inferSelect`.

- [ ] **Step 1: Write the failing test**

```ts
// api/test/energy.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/test/energy.test.ts`
Expected: FAIL (the columns list is empty, so the arrays don't contain the names).

- [ ] **Step 3: Add the tables to `db/schema.ts`**

Add `decimal`, `char` and `date` to the `drizzle-orm/mysql-core` import, then add the following after the storage tables:

```ts
// ---------------------------------------------------------------------------
// Energy — monthly figures per meter item (a Plugwise plug, the grid meter,
// the solar inverter), sent by collectors through energy.report. Measurements,
// not edits: a report writes no item event and never deletes a row. Decimals
// come back as strings; api/lib/energy.ts turns them into numbers.
// ---------------------------------------------------------------------------
export const energyMonths = mysqlTable(
  "energy_months",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }).notNull(),
    month: char("month", { length: 7 }).notNull(), // YYYY-MM, local time
    kwhNormal: decimal("kwhNormal", { precision: 10, scale: 3 }), // use (plug) or grid import, normal rate
    kwhOffpeak: decimal("kwhOffpeak", { precision: 10, scale: 3 }),
    kwhReturnedNormal: decimal("kwhReturnedNormal", { precision: 10, scale: 3 }), // grid only
    kwhReturnedOffpeak: decimal("kwhReturnedOffpeak", { precision: 10, scale: 3 }),
    kwhProduced: decimal("kwhProduced", { precision: 10, scale: 3 }), // solar only
    avgW: decimal("avgW", { precision: 8, scale: 1 }),
    baseW: decimal("baseW", { precision: 8, scale: 1 }), // 10th percentile of the 15-minute averages
    peakW: decimal("peakW", { precision: 8, scale: 1 }),
    hours: decimal("hours", { precision: 6, scale: 1 }), // hours with data
    source: varchar("source", { length: 32 }).notNull().default("collector"),
    measuredAt: timestamp("measuredAt").notNull().defaultNow(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("em_item_month_uq").on(t.itemId, t.month)],
);

// Price per period: a row applies from validFrom until the next row.
export const energyTariffs = mysqlTable(
  "energy_tariffs",
  {
    id: serial("id").primaryKey(),
    validFrom: date("validFrom", { mode: "string" }).notNull(),
    normalEurKwh: decimal("normalEurKwh", { precision: 7, scale: 5 }).notNull(),
    offpeakEurKwh: decimal("offpeakEurKwh", { precision: 7, scale: 5 }).notNull(),
    feedInEurKwh: decimal("feedInEurKwh", { precision: 7, scale: 5 }).notNull(),
    feedInCostEurKwh: decimal("feedInCostEurKwh", { precision: 7, scale: 5 }).notNull(),
    fixedEurDay: decimal("fixedEurDay", { precision: 6, scale: 3 }).notNull(),
    note: varchar("note", { length: 128 }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [uniqueIndex("et_valid_from_uq").on(t.validFrom)],
);
export type EnergyMonthRow = typeof energyMonths.$inferSelect;
export type EnergyTariffRow = typeof energyTariffs.$inferSelect;
```

- [ ] **Step 4: Generate the migration and add the seed row**

Run `npm run db:generate`. Expected: `db/migrations/0009_*.sql` and `meta/0009_snapshot.json` appear. Rename the SQL to `0009_energy.sql` and update its `tag` in `meta/_journal.json` to match. Append:

```sql
--> statement-breakpoint
INSERT INTO `energy_tariffs` (`validFrom`,`normalEurKwh`,`offpeakEurKwh`,`feedInEurKwh`,`feedInCostEurKwh`,`fixedEurDay`,`note`)
VALUES ('2015-01-01', 0.24395, 0.24395, 0.06050, 0.03993, 1.510, 'contract prices 2026; older prices unknown');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run api/test/energy.test.ts`
Expected: PASS (globalSetup migrates the test database).

- [ ] **Step 6: Commit**

```bash
git add db/schema.ts db/migrations/0009_energy.sql db/migrations/meta api/test/energy.test.ts
git commit -m "Energy: monthly meter figures and price periods (migration 0009)"
```

### Task 2: `energy.report`

**Files:**
- Create: `api/lib/energy.ts`
- Create: `api/routers/energy.ts`
- Modify: `api/router.ts` (register `energy: energyRouter`)
- Test: `api/test/energy.test.ts`

**Interfaces:**
- Consumes: `energyMonths` (Task 1).
- Produces:
  - `export type MeterKind = "plug" | "grid" | "solar"`
  - `export const POWERS = "powers"`
  - `export class EnergyReportError extends Error {}`
  - `export function meterKind(item: { attributes: Record<string, string | number> | null }): MeterKind | null`
  - `export function currentMonth(now?: Date): string`
  - `export type ReportMonth = { month: string; kwhNormal?: number; kwhOffpeak?: number; kwhReturnedNormal?: number; kwhReturnedOffpeak?: number; kwhProduced?: number; avgW?: number; baseW?: number; peakW?: number; hours?: number }`
  - `export async function applyEnergyReport(db: Db, input: { itemId: number; source: string; months: ReportMonth[] }, now?: Date): Promise<{ months: number }>`
  - tRPC `energy.report`.

- [ ] **Step 1: Write the failing tests**

Append to `api/test/energy.test.ts`. Add to the imports at the top: `import { eq } from "drizzle-orm"`; `import { areas, events, houses, items, relations, energyMonths } from "@db/schema"`; `import { callerFor } from "./caller"`.

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/energy.test.ts`
Expected: FAIL with "c.energy is undefined" (TypeError).

- [ ] **Step 3: Write `api/lib/energy.ts` (report part)**

```ts
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

export function checkMonths(kind: MeterKind, months: ReportMonth[], now = new Date()): void {
  const cur = currentMonth(now);
  const { required, optional } = FIELDS[kind];
  const allowed = new Set<NumberField>([...required, ...optional]);
  const seen = new Set<string>();
  for (const m of months) {
    const mm = Number(m.month.slice(5));
    if (mm < 1 || mm > 12) throw new EnergyReportError(`${m.month}: not a month.`);
    if (seen.has(m.month)) throw new EnergyReportError(`${m.month}: the month appears twice in this report.`);
    seen.add(m.month);
    if (m.month > cur) throw new EnergyReportError(`${m.month}: after the current month (${cur}).`);
    for (const f of required) if (m[f] == null) throw new EnergyReportError(`${m.month}: ${f} is required for a ${kind} meter.`);
    for (const f of NUMBER_FIELDS) if (m[f] != null && !allowed.has(f)) throw new EnergyReportError(`${m.month}: ${f} does not belong to a ${kind} meter.`);
  }
}

const dec = (v: number | undefined) => (v == null ? null : String(v));

/** Upsert one meter's months in one transaction. Never deletes; writes no item event. */
export async function applyEnergyReport(db: Db, input: { itemId: number; source: string; months: ReportMonth[] }, now = new Date()): Promise<{ months: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new EnergyReportError("Item not found.");
  if (item.status === "archived") throw new EnergyReportError("Item is archived: a report needs an active meter.");
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
```

- [ ] **Step 4: Write `api/routers/energy.ts` and register it**

```ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { EnergyReportError, applyEnergyReport } from "../lib/energy";

const n = z.number().nonnegative().finite();
const reportMonth = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  kwhNormal: n.optional(),
  kwhOffpeak: n.optional(),
  kwhReturnedNormal: n.optional(),
  kwhReturnedOffpeak: n.optional(),
  kwhProduced: n.optional(),
  avgW: n.optional(),
  baseW: n.optional(),
  peakW: n.optional(),
  hours: n.optional(),
});

/**
 * Energy per meter and month (spec: docs/superpowers/specs/2026-10-04-energy-lens-design.md).
 * Reports come from collectors on dockermac-1; they are measurements, so a
 * report writes no item event (AGENTS.md: live meter data is read-only).
 */
export const energyRouter = createRouter({
  report: procedure
    .input(z.object({ itemId: z.number().int(), source: z.string().min(1).max(32), months: z.array(reportMonth).min(1).max(200) }))
    .mutation(async ({ input }) => {
      try {
        return await applyEnergyReport(getDb(), input);
      } catch (e) {
        if (e instanceof EnergyReportError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
    }),
});
```

In `api/router.ts`, add `import { energyRouter } from "./routers/energy";` and the entry `energy: energyRouter,` next to `storage: storageRouter,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run api/test/energy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add api/lib/energy.ts api/routers/energy.ts api/router.ts api/test/energy.test.ts
git commit -m "Energy: energy.report with per-kind field rules"
```

### Task 3: Calculations and `energy.overview`

**Files:**
- Modify: `api/lib/energy.ts` (tariffs, month windows, costs, trend, overview)
- Modify: `api/routers/energy.ts` (add `overview`)
- Test: `api/test/energy.test.ts`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:
  - `export type Tariff = { validFrom: string; normal: number; offpeak: number; feedIn: number; feedInCost: number; fixedPerDay: number; note: string | null }`
  - `export function tariffFor(tariffs: Tariff[], month: string): Tariff | null`
  - `export function lastMonths(n: number, now?: Date): string[]` (oldest first, complete months only)
  - `export function hoursIn(month: string): number`
  - `export type PlugSummary = { itemId: number; name: string; roomId: number | null; roomName: string | null; kwh: number; eur: number | null; avgW: number | null; baseW: number | null; baseEurYear: number | null; peakW: number | null; hours: number; hoursPossible: number; trendPct: number | null; powers: { id: number; name: string }[] }`
  - `export type EnergyOverview = { months: string[]; tariff: Tariff | null; house: { useKwh: number | null; producedKwh: number | null; importKwh: number | null; exportKwh: number | null; unmeasuredKwh: number | null; netCostEur: number | null; fixedEur: number | null; monthsCounted: number; baselineW: number; baselineEurYear: number | null }; plugs: PlugSummary[]; rooms: { roomId: number | null; name: string; kwh: number; eur: number | null }[] }`
  - `export async function energyOverview(db: Db, houseId: number | null, now?: Date): Promise<EnergyOverview>`
  - tRPC `energy.overview({ houseId? })`.

- [ ] **Step 1: Write the failing tests**

```ts
import { energyOverview, hoursIn, lastMonths, tariffFor, applyEnergyReport } from "../lib/energy";
import { energyTariffs } from "@db/schema";

const NOW = new Date(2026, 9, 4, 12); // 4 Oct 2026, local time: last 12 = 2025-10..2026-09
const T = { validFrom: "2015-01-01", normal: 0.25, offpeak: 0.2, feedIn: 0.06, feedInCost: 0.04, fixedPerDay: 1.5, note: null };

describe("energy calculations", () => {
  it("windows are complete months, oldest first", () => {
    expect(lastMonths(3, NOW)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(lastMonths(12, NOW)[0]).toBe("2025-10");
    expect(hoursIn("2026-02")).toBe(28 * 24);
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
    for (const [i, m] of year.entries()) {
      const full = hoursIn(m);
      // fridge: 10 + 5 kWh a month, full coverage; the second year uses 20% more
      const f = i < 12 ? 1 : 1.2;
      await applyEnergyReport(db, { itemId: s.fridgePlug, source: "t", months: [{ month: m, kwhNormal: 10 * f, kwhOffpeak: 5 * f, baseW: 15 + i, peakW: 160, hours: full }] }, NOW);
      // tv plug: only the last 12 months, 70% coverage -> no trend
      if (i >= 12) await applyEnergyReport(db, { itemId: s.tvPlug, source: "t", months: [{ month: m, kwhNormal: 8, kwhOffpeak: 4, baseW: 30, peakW: 300, hours: full * 0.7 }] }, NOW);
      // grid + solar for the last 12 months, except solar misses 2026-09
      if (i >= 12) await applyEnergyReport(db, { itemId: s.grid, source: "t", months: [{ month: m, kwhNormal: 100, kwhOffpeak: 80, kwhReturnedNormal: 50, kwhReturnedOffpeak: 10 }] }, NOW);
      if (i >= 12 && m !== "2026-09") await applyEnergyReport(db, { itemId: s.solar, source: "t", months: [{ month: m, kwhProduced: 300 }] }, NOW);
    }
    // the current, partial month is stored but never counted
    await applyEnergyReport(db, { itemId: s.fridgePlug, source: "t", months: [{ month: "2026-10", kwhNormal: 999, kwhOffpeak: 0 }] }, NOW);
    // a plug in another house never counts here
    await applyEnergyReport(db, { itemId: s.elsewhere, source: "t", months: [{ month: "2026-09", kwhNormal: 500, kwhOffpeak: 0 }] }, NOW);
    return s;
  }

  it("totals, costs, baseline and trend per plug over the last 12 complete months", async () => {
    const s = await fill();
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    const fridge = o.plugs.find((p) => p.itemId === s.fridgePlug)!;
    expect(fridge.kwh).toBeCloseTo(12 * 15 * 1.2, 3);
    expect(fridge.eur).toBeCloseTo(12 * (12 * 0.25 + 6 * 0.2), 3);
    expect(fridge.trendPct).toBeCloseTo(20, 1);
    expect(fridge.baseW).toBe(32.5); // median of 27..38
    expect(fridge.baseEurYear).toBeCloseTo((32.5 / 1000) * 8760 * ((80 / 168) * 0.25 + (88 / 168) * 0.2), 3);
    const tv = o.plugs.find((p) => p.itemId === s.tvPlug)!;
    expect(tv.trendPct).toBeNull(); // 70% coverage and no previous year
    expect(tv.powers.map((p) => p.name).sort()).toEqual(["Mac mini", "Television"]);
    expect(o.plugs.map((p) => p.itemId)).not.toContain(s.elsewhere);
    expect(o.plugs[0].itemId).toBe(s.fridgePlug); // sorted by euros, highest first
  });

  it("house use only counts months that have every source", async () => {
    const s = await fill();
    const o = await energyOverview(getTestDb(), s.houseId, NOW);
    expect(o.house.monthsCounted).toBe(11); // 2026-09 has no solar row
    expect(o.house.useKwh).toBeCloseTo(11 * (180 + 300 - 60), 3);
    const plugs11 = 11 * (15 * 1.2 + 12);
    expect(o.house.unmeasuredKwh).toBeCloseTo(11 * (180 + 300 - 60) - plugs11, 3);
    expect(o.house.importKwh).toBeCloseTo(11 * 180, 3);
    expect(o.house.netCostEur).toBeCloseTo(11 * (100 * 0.25 + 80 * 0.2 - 60 * (0.06 - 0.04)) + o.house.fixedEur!, 3);
  });

  it("is scoped to the session house through the router", async () => {
    const s = await fill();
    const o = await callerFor(s.other).energy.overview({});
    expect(o.plugs.map((p) => p.itemId)).toEqual([s.elsewhere]);
  });
});
```

The router call in the last test uses the real current date, so it only checks membership, not amounts.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/energy.test.ts`
Expected: FAIL with "lastMonths is not a function" (import error).

- [ ] **Step 3: Add the calculations to `api/lib/energy.ts`**

Extend the imports to `import { and, eq, inArray } from "drizzle-orm";` and `import { energyMonths, energyTariffs, items, relations, rooms } from "@db/schema";`, then add:

```ts
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

/** Sum over a window; null when nothing in it. */
function windowStats(rows: Map<string, Month>, window: string[], tariffs: Tariff[]) {
  let kwh = 0, eur = 0, hours = 0, priced = true, any = false;
  const bases: number[] = [];
  let peak: number | null = null;
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
function trend(rows: Map<string, Month>, now: Date, tariffs: Tariff[]): number | null {
  const all = lastMonths(24, now);
  const prev = windowStats(rows, all.slice(0, 12), tariffs);
  const last = windowStats(rows, all.slice(12), tariffs);
  if (prev.hours < 0.8 * prev.hoursPossible || last.hours < 0.8 * last.hoursPossible || prev.kwh <= 0) return null;
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

async function metersOf(db: Db, houseId: number | null) {
  const where = houseId != null ? and(eq(items.status, "active"), eq(items.houseId, houseId)) : eq(items.status, "active");
  const all = await db.select({ id: items.id, name: items.name, roomId: items.roomId, attributes: items.attributes }).from(items).where(where);
  return all.filter((i) => meterKind(i) != null).map((i) => ({ ...i, kind: meterKind(i)! }));
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

export async function energyOverview(db: Db, houseId: number | null, now = new Date()): Promise<EnergyOverview> {
  const months = lastMonths(12, now);
  const window24 = lastMonths(24, now);
  const tariffs = await loadTariffs(db);
  const tariff = tariffFor(tariffs, currentMonth(now));
  const meters = await metersOf(db, houseId);
  const data = await monthsByItem(db, meters.map((m) => m.id), window24);
  const plugMeters = meters.filter((m) => m.kind === "plug");
  const links = await poweredBy(db, plugMeters.map((p) => p.id));
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
      roomName: p.roomId != null ? roomNames.get(p.roomId) ?? null : null,
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
    r.kwh += p.kwh;
    r.eur = r.eur == null || p.eur == null ? null : r.eur + p.eur;
    roomTotals.set(p.roomId, r);
  }

  // house: only months where the grid meter and (if there is one) the inverter both have a row
  const grid = meters.find((m) => m.kind === "grid");
  const solar = meters.find((m) => m.kind === "solar");
  let useKwh = 0, producedKwh = 0, importKwh = 0, exportKwh = 0, unmeasured = 0, netCost = 0, fixed = 0, counted = 0, priced = true;
  for (const m of months) {
    const g = grid ? data.get(grid.id)?.get(m) : undefined;
    const s = solar ? data.get(solar.id)?.get(m) : undefined;
    if (!g || (solar && !s)) continue;
    const t = tariffFor(tariffs, m);
    const imp = used(g);
    const exp = (g.kwhReturnedNormal ?? 0) + (g.kwhReturnedOffpeak ?? 0);
    const prod = s?.kwhProduced ?? 0;
    const use = imp + prod - exp;
    const plugSum = plugMeters.reduce((sum, p) => sum + (data.get(p.id)?.get(m) ? used(data.get(p.id)!.get(m)!) : 0), 0);
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
  const baselineW = plugs.reduce((s, p) => s + (p.baseW ?? 0), 0);
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
```

- [ ] **Step 4: Add `overview` to the router**

```ts
// in api/routers/energy.ts: extend the lib import with energyOverview, then add after report:
  overview: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      return energyOverview(getDb(), houseId);
    }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run api/test/energy.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add api/lib/energy.ts api/routers/energy.ts api/test/energy.test.ts
git commit -m "Energy: overview with costs, baseline, trend, rooms and the house"
```

### Task 4: `energy.forItem` and `energy.setTariff`

**Files:**
- Modify: `api/lib/energy.ts`
- Modify: `api/routers/energy.ts`
- Test: `api/test/energy.test.ts`

**Interfaces:**
- Consumes: Task 3 helpers (`lastMonths`, `windowStats`, `trend`, `tariffFor`, `loadTariffs`, `POWERS`).
- Produces:
  - `export type ItemEnergy = { plug: { id: number; name: string } | null; sharedWith: { id: number; name: string }[]; summary: { kwh: number; eur: number | null; baseW: number | null; peakW: number | null; hours: number; hoursPossible: number; trendPct: number | null } | null; months: { month: string; kwh: number | null; eur: number | null; hours: number | null; hoursPossible: number }[] }`
  - `export async function energyForItem(db: Db, itemId: number, now?: Date): Promise<ItemEnergy | null>` (null = no such item)
  - tRPC `energy.forItem({ itemId })` (NOT_FOUND only for a missing item) and `energy.setTariff(...)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { energyForItem } from "../lib/energy";

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/energy.test.ts`
Expected: FAIL with "energyForItem is not a function".

- [ ] **Step 3: Implement `energyForItem` in `api/lib/energy.ts`**

```ts
export type ItemEnergy = {
  plug: { id: number; name: string } | null;
  sharedWith: { id: number; name: string }[];
  summary: { kwh: number; eur: number | null; baseW: number | null; peakW: number | null; hours: number; hoursPossible: number; trendPct: number | null } | null;
  months: { month: string; kwh: number | null; eur: number | null; hours: number | null; hoursPossible: number }[];
};

/** A plug's figures for the plug itself or for an item it powers. Null when the item does not exist. */
export async function energyForItem(db: Db, itemId: number, now = new Date()): Promise<ItemEnergy | null> {
  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) return null;
  let plug: { id: number; name: string } | null = meterKind(item) === "plug" ? { id: item.id, name: item.name } : null;
  if (!plug) {
    const [rel] = await db
      .select({ id: items.id, name: items.name })
      .from(relations)
      .innerJoin(items, eq(items.id, relations.fromItemId))
      .where(and(eq(relations.type, POWERS), eq(relations.toItemId, itemId), eq(items.status, "active")))
      .limit(1);
    plug = rel ?? null;
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
      ? { kwh: round(w.kwh, 3)!, eur: round(w.eur, 2), baseW: round(w.baseW), peakW: round(w.peakW), hours: round(w.hours)!, hoursPossible: w.hoursPossible, trendPct: trend(rows, now, tariffs) }
      : null,
    months: window24.map((m) => {
      const r = rows.get(m);
      return { month: m, kwh: r ? round(used(r), 3) : null, eur: r ? round(cost(r, tariffFor(tariffs, m)), 2) : null, hours: r?.hours ?? null, hoursPossible: hoursIn(m) };
    }),
  };
}
```

- [ ] **Step 4: Add `forItem` and `setTariff` to the router**

```ts
// api/routers/energy.ts: extend imports with energyForItem, and add
// import { energyTariffs } from "@db/schema"; import { logEvent } from "../lib/events";
  forItem: procedure.input(z.object({ itemId: z.number().int() })).query(async ({ input }) => {
    const e = await energyForItem(getDb(), input.itemId);
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
    return e;
  }),

  setTariff: procedure
    .input(
      z.object({
        validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        normal: n,
        offpeak: n,
        feedIn: n,
        feedInCost: n,
        fixedPerDay: n,
        note: z.string().max(128).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const set = {
        normalEurKwh: String(input.normal),
        offpeakEurKwh: String(input.offpeak),
        feedInEurKwh: String(input.feedIn),
        feedInCostEurKwh: String(input.feedInCost),
        fixedEurDay: String(input.fixedPerDay),
        note: input.note ?? null,
      };
      await getDb().insert(energyTariffs).values({ validFrom: input.validFrom, ...set }).onDuplicateKeyUpdate({ set });
      await logEvent({
        entityType: "energy",
        action: "energy.tariff",
        summary: `Price from ${input.validFrom}: €${input.normal}/kWh normal, €${input.offpeak}/kWh off-peak`,
        payload: input,
      });
      return { validFrom: input.validFrom };
    }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run api/test/energy.test.ts && npm run check`
Expected: PASS (12 tests), and tsc with no errors.

- [ ] **Step 6: Commit**

```bash
git add api/lib/energy.ts api/routers/energy.ts api/test/energy.test.ts
git commit -m "Energy: forItem for plugs and powered items, setTariff with an event"
```

### Task 5: AGENTS.md terms, the Workbench role option, and the Energy section

**Files:**
- Modify: `AGENTS.md` §2 (client contract bullet "Energy collectors"; data-meaning terms)
- Modify: `db/seed.ts` lines 18 and 46 (the `role` select options) and the live Computers topic's `attributeDefs` through `areas.update` (add `meter`; today it lists laptop … service)
- Create: `src/components/EnergySection.tsx`
- Modify: `src/pages/ItemDetail.tsx` (render `<EnergySection itemId={item.id} />` after the Relations section)
- Deploy: live migration 0009 (additive), then tell Rick

**Interfaces:**
- Consumes: `energy.forItem` (Task 4).

- [ ] **Step 1: AGENTS.md**

Add this to §2 after the Storage collectors bullet:

```markdown
- Energy collectors (`~/plugwise/report_energy_homebase.py` and `~/plugwise/report_house_energy.py` on dockermac-1): tRPC `energy.report({ itemId, source, months: [{ month: "YYYY-MM", kwhNormal?, kwhOffpeak?, kwhReturnedNormal?, kwhReturnedOffpeak?, kwhProduced?, avgW?, baseW?, peakW?, hours? }] })`, 1–200 months, every number non-negative, a month never after the current one (local time) and never twice in one report. Fields follow the item's `meter_kind`: `plug` needs kwhNormal/kwhOffpeak and may send avgW/baseW/peakW/hours; `grid` needs kwhNormal/kwhOffpeak (DSMR T2/T1) and kwhReturnedNormal/kwhReturnedOffpeak; `solar` needs kwhProduced; anything else refuses the whole report (BAD_REQUEST). It upserts by (itemId, month) in one transaction, never deletes, and writes no item event, because these are measurements, not edits. Reads: `energy.overview` (last 12 complete months; scoped like storage.overview), `energy.forItem`. Writes by Rick: `energy.setTariff` (logs an event).
```

Under "Data meaning", add role `meter`, the plain keys `meter_kind` (`plug`, `grid`, `solar`) and `solaredge_site`, and the line: "A relation of type `powers` means `fromItemId` (a plug) powers `toItemId` (an appliance)." Leave the `energy.*` tail of the Computer Lab line until Task 11.

- [ ] **Step 2: Workbench role option**

Add `"meter"` to the `role` options in `db/seed.ts` (both lists) and, through `areas.update`, to the live Computers topic's `role` attributeDef. `DATA_ROLES` and `BACKUP_ROLES` stay unchanged.

- [ ] **Step 3: `src/components/EnergySection.tsx`**

```tsx
import { trpc } from "@/providers/trpc";

const EUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Read-only energy figures for a plug or an item a plug powers. Hidden for anything else. */
export function EnergySection({ itemId }: { itemId: number }) {
  const q = trpc.energy.forItem.useQuery({ itemId });
  const e = q.data;
  if (!e || !e.plug) return null;
  const s = e.summary;
  return (
    <section className="rounded-lg border border-border bg-white p-4">
      <div className="flex items-center mb-2">
        <h2 className="micro-label text-muted-foreground">Energy</h2>
        {e.plug.id !== itemId && <span className="ml-auto text-[11px] text-muted-foreground">via {e.plug.name}</span>}
      </div>
      {!s ? (
        <p className="text-[13px] text-muted-foreground">No energy data yet.</p>
      ) : (
        <div className="flex flex-col gap-1 text-[13px]">
          <p className="tabular-nums">
            {Math.round(s.kwh)} kWh · {s.eur != null ? EUR.format(s.eur) : "—"} in the last 12 months
            {s.trendPct != null && ` · ${s.trendPct > 0 ? "+" : ""}${s.trendPct}% on the year before`}
          </p>
          {s.baseW != null && <p className="tabular-nums text-muted-foreground">Always on: {s.baseW} W · peak {s.peakW ?? "—"} W</p>}
          {s.hours < s.hoursPossible * 0.98 && (
            <p className="tabular-nums text-muted-foreground">
              Measured {Math.round(s.hours)} of {s.hoursPossible} hours
            </p>
          )}
          {e.sharedWith.length > 0 && <p className="text-muted-foreground">Shared with {e.sharedWith.map((x) => x.name).join(", ")}</p>}
        </div>
      )}
    </section>
  );
}
```

In `src/pages/ItemDetail.tsx`, import it and render `<EnergySection itemId={item.id} />` right after the Relations `<section>`.

- [ ] **Step 4: Verify**

Run: `npm run check && npx vitest run api/test/energy.test.ts`
Expected: no type errors; tests PASS. Open `/items/<espresso plug id>` on the dev server after Task 10 has run. It should show the section; `/items/<a chair>` should show nothing.

- [ ] **Step 5: Live migration and commit**

Apply 0009 to the live database the way 0007/0008 were applied (additive), restart :3001 on Rick's word, and tell Rick.

```bash
git add AGENTS.md src/components/EnergySection.tsx src/pages/ItemDetail.tsx db/seed.ts
git commit -m "Energy: AGENTS terms and contract, meter role, Workbench energy section"
```

---

## Part II — declutter-flow (setup, collectors, Flow lens)

### Task 6: One-off setup: rooms, meter items, `powers` links

**Files:**
- Create: `scripts/energy-setup.mjs`

**Interfaces:**
- Consumes: existing `rooms.ensure`, `items.create`, `items.listAll`, `items.listRelations`, `items.addRelation`, `houses.list`, `areas.list`, `rooms.list`; Plugwise config `http://10.50.0.147:8000/pw-control.json`.
- Produces: items with `role: "meter"`, `meter_kind`, `mac` (plugs) that Tasks 7–9 find.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// One-off energy setup (spec §1): the 7 missing rooms, 29 Plugwise plug items,
// the grid meter and the inverter, and the certain "powers" links.
// Dry run by default; --apply writes. Re-running is a no-op: rooms, items
// (by mac or name) and links are looked up before anything is created.
const HB = process.env.HOMEBASE_URL ?? "http://10.50.0.102:3001";
const PW = "http://10.50.0.147:8000/pw-control.json";
const APPLY = process.argv.includes("--apply");
const HOUSE = "Thuis RT";
const LINKS = [
  ["000D6F0002786CEF", 53], // Espresso plug -> Espresso Apparaat Krups
  ["000D6F00004BE875", 56], // Vaatwasser plug -> AEG built-in dishwasher
];

const enc = (o) => encodeURIComponent(JSON.stringify({ json: o }));
async function q(path, input = {}) {
  const r = await fetch(`${HB}/api/trpc/${path}?input=${enc(input)}`);
  const b = await r.json();
  if (b.error) throw new Error(`${path}: ${b.error.json?.message}`);
  return b.result.data.json;
}
async function m(path, input) {
  const r = await fetch(`${HB}/api/trpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) });
  const b = await r.json();
  if (b.error) throw new Error(`${path}: ${b.error.json?.message}`);
  return b.result.data.json;
}

const pw = await (await fetch(PW)).json();
const circles = [...(pw.dynamic ?? []), ...(pw.static ?? [])].filter((c, i, a) => a.findIndex((x) => x.mac === c.mac) === i);
const house = (await q("houses.list")).find((h) => h.name === HOUSE);
if (!house) throw new Error(`house "${HOUSE}" not found`);
const area = (await q("areas.list")).find((a) => a.slug === "smarthome");
if (!area) throw new Error("area smarthome not found");
let rooms = (await q("rooms.list")).filter((r) => r.houseId === house.id);
const items = await q("items.listAll", { includeArchived: true, houseId: null });
const rels = await q("items.listRelations", { type: "powers" });

const plan = [];
const plannedRooms = new Set();
const roomId = async (name) => {
  let r = rooms.find((x) => x.name === name);
  if (!r && !plannedRooms.has(name)) {
    plannedRooms.add(name);
    plan.push(`room: create "${name}"`);
    if (APPLY) {
      await m("rooms.ensure", { name, houseId: house.id });
      rooms = (await q("rooms.list")).filter((x) => x.houseId === house.id);
      r = rooms.find((x) => x.name === name);
    }
  }
  return r?.id ?? null;
};
const want = [
  ...circles.map((c) => ({
    key: c.mac,
    name: `Plugwise – ${c.name === "circle+" ? "Circle+" : c.name}`,
    room: c.location,
    attributes: { role: "meter", meter_kind: "plug", brand: "Plugwise", model: c.name === "circle+" ? "Circle+" : "Circle", mac: c.mac },
  })),
  { key: "grid", name: "Slimme meter", room: "Meterkast", attributes: { role: "meter", meter_kind: "grid" } },
  { key: "solar", name: "SolarEdge omvormer", room: "Washok", attributes: { role: "meter", meter_kind: "solar", brand: "SolarEdge", solaredge_site: "181945" } },
];
const byKey = new Map();
for (const w of want) {
  const found = items.find((i) => (w.attributes.mac && i.attributes?.mac === w.attributes.mac) || (!w.attributes.mac && i.attributes?.meter_kind === w.attributes.meter_kind && i.name === w.name));
  if (found) {
    byKey.set(w.key, found.id);
    continue;
  }
  const rid = await roomId(w.room);
  plan.push(`item: create "${w.name}" in ${w.room} ${JSON.stringify(w.attributes)}`);
  if (APPLY) {
    const created = await m("items.create", { areaId: area.id, houseId: house.id, roomId: rid, name: w.name, attributes: w.attributes, verificationStatus: "confirmed" });
    byKey.set(w.key, created.id);
  }
}
for (const [mac, to] of LINKS) {
  const from = byKey.get(mac);
  if (from != null && rels.some((r) => r.fromItemId === from && r.toItemId === to)) continue;
  const target = items.find((i) => i.id === to);
  plan.push(`link: ${mac} powers #${to} ${target?.name ?? "?"}`);
  if (APPLY && from != null) await m("items.addRelation", { fromItemId: from, toItemId: to, type: "powers" });
}
console.log(plan.length ? plan.join("\n") : "nothing to do");
console.log(APPLY ? `applied ${plan.length} changes` : `dry run: ${plan.length} changes (add --apply to write)`);
```

- [ ] **Step 2: Dry run and show Rick the list**

Run: `node scripts/energy-setup.mjs`
Expected: 7 room lines (Hal, Badkamer, Slaapkamer Rick, Slaapkamer Carmen, Slaapkamer Ricardo, Berging, Strijkkamer), 31 item lines and 2 link lines; "dry run: 40 changes". Rick checks the list (spec §8 step 2).

- [ ] **Step 3: Apply**

Run: `node scripts/energy-setup.mjs --apply`
Expected: "applied 40 changes".

- [ ] **Step 4: Re-run to prove it is a no-op**

Run: `node scripts/energy-setup.mjs`
Expected: "nothing to do".

- [ ] **Step 5: Commit**

```bash
git add scripts/energy-setup.mjs
git commit -m "Energy: one-off setup of rooms, meter items and powers links"
```

### Task 7: Plugwise collector

**Files:**
- Create: `scripts/collectors/energy/report_energy_homebase.py` (deployed to `~/plugwise/` on dockermac-1)
- Create: `scripts/collectors/energy/homebase.py` (shared HomeBase client, deployed alongside)
- Test: `scripts/collectors/energy/test_report_energy.py` (`python3 -m unittest`)
- Modify (on dockermac-1): `~/plugwise/cron_full_energy_sync.sh` (call the collector after processing)

**Interfaces:**
- Consumes: `energy.report` (Task 2) and the meter items (Task 6); SQLite `energy_readings(mac_address, timestamp_15min, avg_power_w, min_power_w, max_power_w, sample_count)`.
- Produces: `aggregate(rows) -> dict[str, dict]` (month → report month), `homebase.meters(kind) -> list[dict]`, `homebase.report(item_id, source, months)`.

- [ ] **Step 1: Write the failing test**

```python
# scripts/collectors/energy/test_report_energy.py
import unittest
from report_energy_homebase import aggregate, is_offpeak, months_to_send
from datetime import datetime

class AggregateTest(unittest.TestCase):
    def test_offpeak_hours(self):
        self.assertTrue(is_offpeak(datetime(2026, 10, 3, 12)))   # Saturday
        self.assertTrue(is_offpeak(datetime(2026, 10, 5, 23)))   # Monday 23:00
        self.assertTrue(is_offpeak(datetime(2026, 10, 5, 6, 45)))
        self.assertFalse(is_offpeak(datetime(2026, 10, 5, 7)))
        self.assertFalse(is_offpeak(datetime(2026, 10, 5, 22, 45)))

    def test_month_figures(self):
        rows = [("2026-10-05T12:00:00", 100.0, 120.0), ("2026-10-05T23:00:00", 40.0, 50.0), ("2026-10-05T23:15:00", -0.3, 0.0)]
        m = aggregate(rows)["2026-10"]
        self.assertAlmostEqual(m["kwhNormal"], 0.025)          # 100 W x 0.25 h
        self.assertAlmostEqual(m["kwhOffpeak"], 0.010)         # 40 W x 0.25 h; -0.3 W clamps to 0
        self.assertEqual(m["hours"], 0.8)                      # 3 x 0.25 h, one decimal like the column
        self.assertEqual(m["peakW"], 120.0)
        self.assertGreaterEqual(m["baseW"], 0)                 # never negative
        self.assertAlmostEqual(m["avgW"], round(0.035 * 1000 / 0.75, 1))

    def test_nightly_months(self):
        self.assertEqual(months_to_send(datetime(2026, 10, 1, 1)), ["2026-09", "2026-10"])
        self.assertEqual(months_to_send(datetime(2026, 1, 15, 1)), ["2025-12", "2026-01"])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd scripts/collectors/energy && python3 -m unittest test_report_energy -v`
Expected: FAIL with "ModuleNotFoundError: No module named 'report_energy_homebase'".

- [ ] **Step 3: Write `homebase.py` and `report_energy_homebase.py`**

```python
# scripts/collectors/energy/homebase.py
"""Tiny HomeBase tRPC client for the energy collectors."""
import json, os, urllib.parse, urllib.request

BASE = os.environ.get("HOMEBASE_URL", "http://10.50.0.102:3001")

def _get(path, inp):
    url = f"{BASE}/api/trpc/{path}?input=" + urllib.parse.quote(json.dumps({"json": inp}))
    body = json.load(urllib.request.urlopen(url, timeout=30))
    if "error" in body:
        raise RuntimeError(f"{path}: {body['error']['json'].get('message')}")
    return body["result"]["data"]["json"]

def meters(kind):
    """Active meter items of one kind (plug, grid, solar), in every house."""
    items = _get("items.listAll", {"includeArchived": False, "houseId": None})
    return [i for i in items if (i.get("attributes") or {}).get("role") == "meter" and (i.get("attributes") or {}).get("meter_kind") == kind]

def report(item_id, source, months):
    """Send months in chunks of 200 (the contract's limit)."""
    for i in range(0, len(months), 200):
        data = json.dumps({"json": {"itemId": item_id, "source": source, "months": months[i:i + 200]}}).encode()
        req = urllib.request.Request(f"{BASE}/api/trpc/energy.report", data=data, headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"energy.report #{item_id}: {json.load(e).get('error', {}).get('json', {}).get('message', e)}")
```

```python
#!/usr/bin/env python3
# scripts/collectors/energy/report_energy_homebase.py
"""Send each Plugwise plug's monthly figures to HomeBase (energy.report).

Reads the 15-minute rows of ~/plugwise/plugwise_energy_complete_history.db
and sends the previous and the current month for every plug item (found by
its mac). --all sends every month in the database; --dry-run prints and
sends nothing. Small negative readings (idle plugs) count as 0.
"""
import argparse, json, os, sqlite3, sys
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import homebase

DB = os.path.expanduser("~/plugwise/plugwise_energy_complete_history.db")

def is_offpeak(t):
    """Dutch off-peak: weekdays 23:00-07:00, weekends all day (holidays ignored)."""
    return t.weekday() >= 5 or t.hour >= 23 or t.hour < 7

def percentile(values, p):
    s = sorted(values)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)

def aggregate(rows):
    """rows: (timestamp_15min, avg_power_w, max_power_w) of one plug -> {month: report month}."""
    acc = {}
    for ts, avg, mx in rows:
        t = datetime.fromisoformat(ts)
        a = acc.setdefault(t.strftime("%Y-%m"), {"n": 0, "norm": 0.0, "off": 0.0, "avgs": [], "peak": 0.0})
        w = max(float(avg), 0.0)
        kwh = w * 0.25 / 1000
        a["off" if is_offpeak(t) else "norm"] += kwh
        a["n"] += 1
        a["avgs"].append(w)
        a["peak"] = max(a["peak"], float(mx or 0))
    out = {}
    for month, a in acc.items():
        hours = a["n"] * 0.25
        kwh = a["norm"] + a["off"]
        out[month] = {
            "month": month,
            "kwhNormal": round(a["norm"], 3),
            "kwhOffpeak": round(a["off"], 3),
            "avgW": round(kwh * 1000 / hours, 1) if hours else 0.0,
            "baseW": round(percentile(a["avgs"], 0.10), 1),
            "peakW": round(max(a["peak"], 0.0), 1),
            "hours": round(hours, 1),
        }
    return out

def months_to_send(now):
    prev = f"{now.year - 1}-12" if now.month == 1 else f"{now.year}-{now.month - 1:02d}"
    return [prev, now.strftime("%Y-%m")]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    wanted = None if args.all else months_to_send(datetime.now())
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sent = failed = 0
    for plug in homebase.meters("plug"):
        mac = (plug.get("attributes") or {}).get("mac")
        if not mac:
            continue
        rows = con.execute("SELECT timestamp_15min, avg_power_w, max_power_w FROM energy_readings WHERE mac_address = ? ORDER BY timestamp_15min", (mac,)).fetchall()
        months = [m for k, m in sorted(aggregate(rows).items()) if wanted is None or k in wanted]
        if not months:
            continue
        if args.dry_run:
            print(plug["name"], json.dumps(months[-1]), f"({len(months)} months)")
            continue
        try:
            homebase.report(plug["id"], "plugwise", months)
            sent += len(months)
        except Exception as e:  # one plug failing must not stop the others
            failed += 1
            print(f"WARNING: {plug['name']}: {e}", file=sys.stderr)
    print(f"energy report: {sent} months sent, {failed} plugs failed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/collectors/energy && python3 -m unittest test_report_energy -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Deploy and dry-run against the real database**

```bash
scp scripts/collectors/energy/{homebase.py,report_energy_homebase.py} rick@10.50.0.10:plugwise/
ssh rick@10.50.0.10 'cd ~/plugwise && python3 report_energy_homebase.py --all --dry-run | tail -5'
```
Expected: one line per plug with its last month, and about 70 months each for long-lived plugs. This needs the Task 6 items; before Task 2 is live, only the dry run works.

- [ ] **Step 6: Hook into the nightly sync (after Task 2 is live)**

In `~/plugwise/cron_full_energy_sync.sh`, inside the `if [ $TOTAL_COPIED -gt 0 ]` block, right after the top consumers step, add:

```bash
    # Monthly figures per plug to HomeBase (Energy lens)
    log "Sending monthly figures to HomeBase..."
    if python3 report_energy_homebase.py >>"$LOG_FILE" 2>&1; then
        log "HomeBase energy report sent"
    else
        log "WARNING: HomeBase energy report had failures"
    fi
```

- [ ] **Step 7: Commit**

```bash
git add scripts/collectors/energy/homebase.py scripts/collectors/energy/report_energy_homebase.py scripts/collectors/energy/test_report_energy.py
git commit -m "Energy: Plugwise collector for monthly figures per plug"
```

### Task 8: House collector (DSMR-reader + SolarEdge)

**Files:**
- Create: `scripts/collectors/energy/report_house_energy.py` (deployed to `~/plugwise/`)
- Test: `scripts/collectors/energy/test_report_house.py`
- Modify (on dockermac-1): crontab line `40 1 * * * cd /home/rick/plugwise && python3 report_house_energy.py >> logs/house_energy.log 2>&1`

**Interfaces:**
- Consumes: `homebase.meters`, `homebase.report` (Task 7), `energy.report` (Task 2); DSMR-reader `GET /api/v2/statistics/day` (fields `day`, `electricity1`, `electricity2`, `electricity1_returned`, `electricity2_returned`; Authorization `Token …`); SolarEdge `GET /site/181945/energy?timeUnit=MONTH&startDate&endDate&api_key` (values in Wh).
- Produces: `grid_months(days) -> list[dict]`, `solar_months(values) -> list[dict]`.

- [ ] **Step 1: Write the failing test**

```python
# scripts/collectors/energy/test_report_house.py
import unittest
from report_house_energy import grid_months, solar_months

class HouseTest(unittest.TestCase):
    def test_grid_sums_days_per_month_t2_normal_t1_offpeak(self):
        days = [
            {"day": "2026-09-29", "electricity1": "10.5", "electricity2": "2.0", "electricity1_returned": "1.0", "electricity2_returned": "4.0"},
            {"day": "2026-09-30", "electricity1": "9.5", "electricity2": "1.0", "electricity1_returned": "0.0", "electricity2_returned": "6.0"},
            {"day": "2026-10-01", "electricity1": "8.0", "electricity2": "0.0", "electricity1_returned": "0.5", "electricity2_returned": "0.0"},
        ]
        m = {x["month"]: x for x in grid_months(days)}
        self.assertEqual(m["2026-09"], {"month": "2026-09", "kwhNormal": 3.0, "kwhOffpeak": 20.0, "kwhReturnedNormal": 10.0, "kwhReturnedOffpeak": 1.0, "hours": 48.0})
        self.assertEqual(m["2026-10"]["hours"], 24.0)

    def test_solar_skips_empty_months_and_converts_wh(self):
        values = [{"date": "2026-08-01 00:00:00", "value": 512340.0}, {"date": "2026-09-01 00:00:00", "value": None}]
        self.assertEqual(solar_months(values), [{"month": "2026-08", "kwhProduced": 512.34}])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd scripts/collectors/energy && python3 -m unittest test_report_house -v`
Expected: FAIL with "No module named 'report_house_energy'".

- [ ] **Step 3: Write `report_house_energy.py`**

```python
#!/usr/bin/env python3
# scripts/collectors/energy/report_house_energy.py
"""Send the house's monthly grid import/export (DSMR-reader) and solar
production (SolarEdge) to HomeBase (energy.report).

Secrets are read at runtime from their existing files on dockermac-1 and are
never printed: the DSMR-reader token from ~/html/api/dsmr.php, the SolarEdge
key from ~/tesla/.env. Nightly it sends the previous and the current month;
--all sends everything (DSMR from 2020-07, SolarEdge from 2015-10).
"""
import argparse, json, os, re, sys, urllib.request
from datetime import date, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import homebase
from report_energy_homebase import months_to_send

DSMR = "http://10.50.0.143/api/v2/statistics/day"
SOLAREDGE = "https://monitoringapi.solaredge.com/site/181945/energy"

def _dsmr_token():
    src = open(os.path.expanduser("~/html/api/dsmr.php")).read()
    return re.search(r"\$key\s*=\s*['\"]([^'\"]+)['\"]", src).group(1)

def _solaredge_key():
    for line in open(os.path.expanduser("~/tesla/.env")):
        if line.startswith("SOLAREDGE_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise RuntimeError("SOLAREDGE_API_KEY not found")

def grid_months(days):
    """DSMR day statistics -> grid report months. T2 (electricity2) is normal, T1 is off-peak."""
    acc = {}
    for d in days:
        m = d["day"][:7]
        a = acc.setdefault(m, {"month": m, "kwhNormal": 0.0, "kwhOffpeak": 0.0, "kwhReturnedNormal": 0.0, "kwhReturnedOffpeak": 0.0, "hours": 0.0})
        a["kwhNormal"] += float(d["electricity2"] or 0)
        a["kwhOffpeak"] += float(d["electricity1"] or 0)
        a["kwhReturnedNormal"] += float(d["electricity2_returned"] or 0)
        a["kwhReturnedOffpeak"] += float(d["electricity1_returned"] or 0)
        a["hours"] += 24.0
    return [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in a.items()} for _, a in sorted(acc.items())]

def solar_months(values):
    """SolarEdge MONTH values (Wh, None for no data) -> solar report months."""
    return [{"month": v["date"][:7], "kwhProduced": round(v["value"] / 1000, 3)} for v in values if v.get("value") is not None]

def fetch_dsmr(since):
    token, url, days = _dsmr_token(), f"{DSMR}?ordering=day&limit=500&day__gte={since}", []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Token {token}"})
        page = json.load(urllib.request.urlopen(req, timeout=30))
        days += page["results"]
        url = page.get("next")
    return days

def fetch_solar(since):
    url = f"{SOLAREDGE}?timeUnit=MONTH&startDate={since}&endDate={date.today()}&api_key={_solaredge_key()}"
    return json.load(urllib.request.urlopen(url, timeout=30))["energy"]["values"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    wanted = months_to_send(datetime.now())
    failed = 0
    for kind, since, fetch, shape in (("grid", "2020-07-01", fetch_dsmr, grid_months), ("solar", "2015-10-01", fetch_solar, solar_months)):
        meters = homebase.meters(kind)
        if len(meters) != 1:
            print(f"WARNING: expected one {kind} meter, found {len(meters)}", file=sys.stderr)
            failed += 1
            continue
        try:
            start = since if args.all else f"{wanted[0]}-01"
            months = [m for m in shape(fetch(start)) if args.all or m["month"] in wanted]
            if args.dry_run:
                print(kind, len(months), "months; last:", json.dumps(months[-1]) if months else "-")
            else:
                homebase.report(meters[0]["id"], "dsmr" if kind == "grid" else "solaredge", months)
                print(f"{kind}: {len(months)} months sent")
        except Exception as e:  # never print the request URL: it carries the SolarEdge key
            failed += 1
            print(f"WARNING: {kind}: {type(e).__name__}", file=sys.stderr)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/collectors/energy && python3 -m unittest test_report_house test_report_energy -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Deploy and dry-run**

```bash
scp scripts/collectors/energy/report_house_energy.py rick@10.50.0.10:plugwise/
ssh rick@10.50.0.10 'cd ~/plugwise && python3 report_house_energy.py --all --dry-run'
```
Expected: `grid ~75 months; last: {...}` and `solar ~132 months; last: {...}`. The 2025 solar total should match SolarEdge's 4,465 kWh.

- [ ] **Step 6: Commit**

```bash
git add scripts/collectors/energy/report_house_energy.py scripts/collectors/energy/test_report_house.py
git commit -m "Energy: house collector for grid import/export and solar production"
```

### Task 9: Flow "⚡ Energy" lens

**Files:**
- Modify: `src/flow/lenses.ts` (`LensKey`, lens storage, `meter` role, `inLab` excludes meters, `POWERS`)
- Modify: `src/flow/FlowApp.tsx` (Energy chip)
- Create: `src/flow/EnergyParts.tsx` (`EnergyFind`, `EnergyCard`, `PowersPicker`, `PriceSheet`)
- Modify: `src/flow/FindTab.tsx` (energy view when the lens is on; card section)

**Interfaces:**
- Consumes: `energy.overview`, `energy.forItem`, `energy.setTariff` (Tasks 3–4); `items.addRelation`, `items.removeRelation`, `items.listRelations`.
- Produces: `LensKey = "lab" | "energy"`.

- [ ] **Step 1: Lens plumbing in `src/flow/lenses.ts`**

```ts
export type LensKey = "lab" | "energy";
// ROLES: add after the network entry
  { value: "meter", label: "Meter" },
/** relation type: fromItemId (a plug) powers toItemId (an appliance) */
export const POWERS = "powers";
// inLab: meters belong to the energy lens, never to the lab
export function inLab(it: FlowItem) {
  if (attr(it, LAB_KEYS.exclude) === "yes") return false;
  if (role(it) === "meter") return false;
  if (role(it)) return true;
  return !!it.areaSlug && LAB.areaSlugs.includes(it.areaSlug);
}
// getLens: accept both lenses
export function getLens(): LensKey | null {
  try {
    const v = localStorage.getItem(LENS_KEY);
    return v === "lab" || v === "energy" ? v : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Header chip in `src/flow/FlowApp.tsx`**

Add `Zap` to the lucide import. After the Lab button, add:

```tsx
          <button
            onClick={() => setLens(lens === "energy" ? null : "energy")}
            aria-pressed={lens === "energy"}
            title="Energy lens"
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-data text-[12px]",
              lens === "energy" ? "bg-[#d2ff00] font-semibold text-[#282c20]" : "bg-[#3a3f2e] text-[#b4b8a5]",
            )}
          >
            <Zap className="h-3.5 w-3.5" /> Energy
          </button>
```

- [ ] **Step 3: `src/flow/EnergyParts.tsx`**

```tsx
import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { trpc } from "@/providers/trpc";
import { useFlow } from "./context";
import { Sheet } from "./ui";
import { euro } from "./data";
import { POWERS } from "./lenses";

const kwh = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v).toLocaleString("nl-NL")} kWh`);
const eur = (v: number | null | undefined) => (v == null ? "—" : euro(v));

/** Find with the Energy lens on: the house, top consumers, baseline load, rooms. */
export function EnergyFind({ onOpen }: { onOpen: (itemId: number) => void }) {
  const o = trpc.energy.overview.useQuery({});
  const [priceOpen, setPriceOpen] = useState(false);
  if (!o.data) return <p className="py-10 text-center text-[13px] text-muted-foreground">Loading energy…</p>;
  const { house, plugs, rooms, tariff, months } = o.data;
  const top = plugs.filter((p) => p.kwh > 0).slice(0, 10);
  const base = [...plugs].filter((p) => (p.baseW ?? 0) >= 1).sort((a, b) => (b.baseW ?? 0) - (a.baseW ?? 0)).slice(0, 10);
  const maxRoom = Math.max(1, ...rooms.map((r) => r.kwh));
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1 rounded-xl border border-border bg-white p-3 text-[13px]">
        <span className="micro-label text-muted-foreground">
          The house · {months[0]} – {months.at(-1)}
        </span>
        {house.monthsCounted === 0 ? (
          <p className="text-muted-foreground">No meter data yet.</p>
        ) : (
          <>
            <p className="tabular-nums">
              Used {kwh(house.useKwh)} · produced {kwh(house.producedKwh)} · net cost {eur(house.netCostEur)}
            </p>
            <p className="tabular-nums text-muted-foreground">
              Not on a plug {kwh(house.unmeasuredKwh)}
              {house.monthsCounted < 12 && ` · ${house.monthsCounted} of 12 months complete`}
            </p>
          </>
        )}
        <p className="tabular-nums text-muted-foreground">
          Always on: {Math.round(house.baselineW)} W on the plugs · {eur(house.baselineEurYear)} a year
        </p>
        <button onClick={() => setPriceOpen(true)} className="self-start font-data text-[12px] text-[#3C5D41] underline">
          {tariff ? `€${tariff.normal.toFixed(3)} per kWh` : "Set a price per kWh"}
        </button>
      </section>

      <PlugList title="Top consumers (12 months)" rows={top} value={(p) => `${eur(p.eur)} · ${kwh(p.kwh)}`} onOpen={onOpen} />
      <PlugList title="Always on" rows={base} value={(p) => `${Math.round(p.baseW ?? 0)} W · ${eur(p.baseEurYear)}/yr`} onOpen={onOpen} />

      <section className="flex flex-col gap-1.5 rounded-xl border border-border bg-white p-3">
        <span className="micro-label text-muted-foreground">Per room (plugs)</span>
        {rooms.map((r) => (
          <div key={String(r.roomId)} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-[12px]">
            <span className="truncate">{r.name}</span>
            <span className="h-2 rounded-full bg-[#2F7A45]/80" style={{ width: `${(r.kwh / maxRoom) * 100}%` }} />
            <span className="tabular-nums text-muted-foreground">{eur(r.eur)}</span>
          </div>
        ))}
      </section>

      {priceOpen && <PriceSheet onClose={() => setPriceOpen(false)} current={tariff} />}
    </div>
  );
}

type Plug = inferRouterOutputs<AppRouter>["energy"]["overview"]["plugs"][number];
function PlugList({ title, rows, value, onOpen }: { title: string; rows: Plug[]; value: (p: Plug) => string; onOpen: (id: number) => void }) {
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-border bg-white p-3">
      <span className="micro-label text-muted-foreground">{title}</span>
      {rows.length === 0 && <p className="text-[13px] text-muted-foreground">No plug data yet.</p>}
      {rows.map((p) => (
        <button key={p.itemId} onClick={() => onOpen(p.itemId)} className="flex items-baseline gap-2 py-1 text-left text-[13px]">
          <span className="min-w-0 flex-1 truncate">
            {p.name.replace(/^Plugwise – /, "")}
            <span className="text-muted-foreground"> · {p.roomName ?? "no room"}</span>
          </span>
          <span className="shrink-0 tabular-nums">{value(p)}</span>
        </button>
      ))}
    </section>
  );
}

/** The energy block on a thing's card: its plug's figures, a 24-month line, sharing and linking. */
export function EnergyCard({ itemId, isPlug }: { itemId: number; isPlug: boolean }) {
  const e = trpc.energy.forItem.useQuery({ itemId });
  const [linkOpen, setLinkOpen] = useState(false);
  if (!e.data || (!e.data.plug && !isPlug)) return null;
  const { plug, summary, months, sharedWith } = e.data;
  const pts = months.map((m) => m.kwh ?? 0);
  const max = Math.max(1, ...pts);
  const path = pts.map((v, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, pts.length - 1)) * 100},${30 - (v / max) * 28}`).join(" ");
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-white p-3 text-[13px]">
      <span className="micro-label text-muted-foreground">Energy</span>
      {plug && plug.id !== itemId && <p className="text-muted-foreground">via {plug.name}</p>}
      {!summary ? (
        <p className="text-muted-foreground">No energy data yet.</p>
      ) : (
        <>
          <p className="tabular-nums">
            {kwh(summary.kwh)} · {eur(summary.eur)} in 12 months
            {summary.trendPct != null && ` · ${summary.trendPct > 0 ? "+" : ""}${summary.trendPct}%`}
          </p>
          <p className="tabular-nums text-muted-foreground">
            Always on {summary.baseW ?? "—"} W · peak {summary.peakW ?? "—"} W
          </p>
          {summary.hours < summary.hoursPossible * 0.98 && (
            <p className="tabular-nums text-muted-foreground">
              Measured {Math.round(summary.hours)} of {summary.hoursPossible} hours
            </p>
          )}
          <svg viewBox="0 0 100 32" className="h-10 w-full" preserveAspectRatio="none" aria-label="kWh per month, last 24 months">
            <path d={path} fill="none" stroke="#2F7A45" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        </>
      )}
      {sharedWith.length > 0 && <p className="text-muted-foreground">{isPlug ? "Powers" : "Shared with"} {sharedWith.map((x) => x.name).join(", ")}</p>}
      {isPlug && (
        <button onClick={() => setLinkOpen(true)} className="self-start text-[12px] text-[#3C5D41] underline">
          Powers…
        </button>
      )}
      {linkOpen && plug && <PowersPicker plugId={plug.id} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

/** Link or unlink the things a plug powers. */
function PowersPicker({ plugId, onClose }: { plugId: number; onClose: () => void }) {
  const { items, refresh } = useFlow();
  const utils = trpc.useUtils();
  const rels = trpc.items.listRelations.useQuery({ type: POWERS });
  const done = () => {
    utils.energy.invalidate();
    rels.refetch();
    refresh();
  };
  const add = trpc.items.addRelation.useMutation({ onSuccess: done });
  const remove = trpc.items.removeRelation.useMutation({ onSuccess: done });
  const [q, setQ] = useState("");
  const linked = useMemo(
    () => new Map((rels.data ?? []).filter((r) => r.fromItemId === plugId).map((r) => [r.toItemId, r.id])),
    [rels.data, plugId],
  );
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items
      .filter((it) => it.status === "active" && it.id !== plugId && String(it.attributes?.role ?? "") !== "meter")
      .filter((it) => linked.has(it.id) || (t.length >= 2 && it.name.toLowerCase().includes(t)))
      .slice(0, 30);
  }, [items, q, plugId, linked]);
  return (
    <Sheet title="This plug powers…" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <input
          id="powers-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a thing"
          className="rounded-xl border border-input bg-white px-3 py-2 text-[16px]"
        />
        {hits.map((it) => {
          const relId = linked.get(it.id);
          return (
            <label key={it.id} className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-[14px]">
              <input
                type="checkbox"
                checked={relId != null}
                disabled={add.isPending || remove.isPending}
                onChange={() => (relId != null ? remove.mutate({ id: relId }) : add.mutate({ fromItemId: plugId, toItemId: it.id, type: POWERS }))}
              />
              {it.name}
            </label>
          );
        })}
        {hits.length === 0 && <p className="text-[13px] text-muted-foreground">Type two letters to find a thing.</p>}
      </div>
    </Sheet>
  );
}

/** Add a price from a date onward. */
function PriceSheet({ current, onClose }: { current: { normal: number; offpeak: number; feedIn: number; feedInCost: number; fixedPerDay: number } | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const set = trpc.energy.setTariff.useMutation({
    onSuccess: () => {
      utils.energy.invalidate();
      onClose();
    },
  });
  const [f, setF] = useState({
    validFrom: new Date().toISOString().slice(0, 10),
    normal: String(current?.normal ?? ""),
    offpeak: String(current?.offpeak ?? ""),
    feedIn: String(current?.feedIn ?? ""),
    feedInCost: String(current?.feedInCost ?? ""),
    fixedPerDay: String(current?.fixedPerDay ?? ""),
  });
  const fields: [keyof typeof f, string][] = [
    ["validFrom", "From (date)"],
    ["normal", "Normal €/kWh"],
    ["offpeak", "Off-peak €/kWh"],
    ["feedIn", "Feed-in €/kWh"],
    ["feedInCost", "Feed-in cost €/kWh"],
    ["fixedPerDay", "Fixed €/day"],
  ];
  const nums = fields.slice(1).map(([k]) => Number(f[k].replace(",", ".")));
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(f.validFrom) && nums.every((x) => Number.isFinite(x) && x >= 0);
  return (
    <Sheet title="Price per kWh" onClose={onClose}>
      <div className="flex flex-col gap-2">
        {fields.map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-2 text-[13px]">
            {label}
            <input
              id={`price-${k}`}
              value={f[k]}
              inputMode={k === "validFrom" ? "text" : "decimal"}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
              className="w-36 rounded-lg border border-input px-2 py-1 text-right tabular-nums"
            />
          </label>
        ))}
        <button
          disabled={!ok || set.isPending}
          onClick={() => {
            const [normal, offpeak, feedIn, feedInCost, fixedPerDay] = nums;
            set.mutate({ validFrom: f.validFrom, normal, offpeak, feedIn, feedInCost, fixedPerDay });
          }}
          className="mt-1 rounded-xl bg-[#282c20] py-2.5 text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
        >
          Save price
        </button>
        {set.error && <p className="text-[12px] text-[#AD432B]">{set.error.message}</p>}
      </div>
    </Sheet>
  );
}
```

- [ ] **Step 4: Wire it into `src/flow/FindTab.tsx`**

- Import `EnergyCard` and `EnergyFind` from `./EnergyParts`.
- In `FindTab`, when `lens === "energy"` and `q` is empty, render `<EnergyFind onOpen={setOpenId} />` instead of the "Recently changed" list. Typing still searches as usual.
- `open` must find meter items too: they are ordinary items, so `items.find` already covers them.
- In `ThingSheet`, add this before the Decision label: `{(lens === "energy" || role(item) === "meter") && <EnergyCard itemId={item.id} isPlug={item.attributes?.meter_kind === "plug"} />}`.

The card also appears with the lens off for meters, and for a powered item whenever the lens is on.

- [ ] **Step 5: Verify**

Run: `npm run check && npm run lint -- src/flow`
Expected: no errors.

Then on the dev server (https :3000/flow/), with the Energy lens on, check the following on a phone width:
- Find shows the four blocks.
- The Espresso plug's card shows kWh, euros and the line.
- The dishwasher's card shows "via Plugwise – Vaatwasser".
- "Powers…" links and unlinks a thing.
- Lab mode no longer counts the meters.

- [ ] **Step 6: Commit**

```bash
git add src/flow/lenses.ts src/flow/FlowApp.tsx src/flow/EnergyParts.tsx src/flow/FindTab.tsx
git commit -m "Flow: Energy lens with the house, top consumers, baseline, rooms and plug cards"
```

### Task 10: Backfill, nightly runs and a check against known totals

**Files:** none new (operations on dockermac-1 and HomeBase live; needs Tasks 2–8 live)

- [ ] **Step 1: Full history**

```bash
ssh rick@10.50.0.10 'cd ~/plugwise && python3 report_energy_homebase.py --all && python3 report_house_energy.py --all'
```
Expected: "energy report: ~2,000 months sent, 0 plugs failed", "grid: ~75 months sent", "solar: ~132 months sent".

- [ ] **Step 2: Re-run to prove it is idempotent**

Run the same command again; then `curl -s "$HB/api/trpc/energy.overview?input=%7B%22json%22%3A%7B%7D%7D"`.
Expected: the same totals as after step 1.

- [ ] **Step 3: Check against known figures**

- Plugwise total for 2025 = 2,881 kWh (±1%) over 28 plugs (sum the 2025 months per plug from the DB rows, or use the overview with a fixed window).
- SolarEdge 2025 = 4,465 kWh.
- The espresso plug for 2025 ≈ 35.6 kWh and the dishwasher ≈ 269.4 kWh.

- [ ] **Step 4: Nightly**

Confirm the hook from Task 7 step 6 and the 01:40 crontab line from Task 8 are in place. The next morning, check that `logs/full_energy_sync_*.log` shows "HomeBase energy report sent" and that `logs/house_energy.log` shows "grid: 2 months sent" and "solar: 2 months sent".

### Task 11: Remove the interim `energy.*` keys

**Needs:** Task 5 (the Workbench section) shipped and Task 10 data in.

- [ ] **Step 1 (declutter-flow):** clear the keys on #53 and #56.

```bash
for id in 53 56; do curl -s -X POST "$HB/api/trpc/items.patchAttributes" -H 'content-type: application/json' \
  -d "{\"json\":{\"id\":$id,\"set\":{\"energy.kwh_2025\":null,\"energy.avg_w_2025\":null,\"energy.days_2025\":null,\"energy.meter\":null}}}"; done
```
Expected: two OK responses. `/items/53` still shows energy figures, now through the Energy section via its plug.

- [ ] **Step 2 (declutter-main):** remove the `energy.*` sentence from the Computer Lab line in AGENTS.md and commit "AGENTS: energy per plug replaces the interim energy.* keys".
