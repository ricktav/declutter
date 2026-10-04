# Energy lens — design

Date: 4 Oct 2026. Agreed with Rick in a brainstorm (declutter-flow session). This is part A of the electrical pack: energy use per appliance, plus the house as a whole. Parts B (the installation: groups, phases, sockets) and C (live readings) get their own specs later.

## What Rick wants

Rick's answers:
- **Questions A must answer:** what an item costs per year, the top consumers, what draws power all the time (baseline load), whether something uses more than before (trend), and use per room.
- **Plugs are items.** Each Plugwise plug becomes a thing in its room, linked to the items it powers.
- **Cost uses day and night rates.** His contract has one rate for both today: €0.24395/kWh including VAT and levies.
- **Rooms:** the 7 missing rooms are created, and each plug goes into its Plugwise room.
- **Where:** a Flow lens, "⚡ Energy", next to Lab, plus a short read-only section on the Workbench item page.
- **Pipeline:** monthly figures per meter in a HomeBase table, sent nightly by collectors through an `energy.report` interface.
- **The house:** use the DSMR total meter. There are solar panels; SolarEdge production can be read through the API the Tesla charger on dockermac-1 already uses. The inverter is in the Washok (attic).
- **One correction:** the "Printer" plug in the Kantoor is not connected to the Epson in the Eetkamer. It powered a Canon MP830 that is gone.

Assumptions, not stated by Rick:
- "Last 12 months" means the 12 complete months before the current one.
- Off-peak hours are the Dutch default: Monday to Friday 23:00–07:00, and Saturday and Sunday all day. Public holidays are ignored.

## Sources (found 4 Oct 2026)

| Source | Where | What | History |
|---|---|---|---|
| Plugwise (28 Circles + Circle+) | Pi 10.50.0.147; history DB `~/plugwise/plugwise_energy_complete_history.db` on dockermac-1 (10.50.0.10), table `energy_readings(mac_address, timestamp_15min, avg_power_w, min_power_w, max_power_w, sample_count)`, filled nightly by `cron_full_energy_sync.sh` | 15-minute power per plug | 2020 onward, with holes (2025-01-01..14, 2025-06-17..07-16, 2026-01-01..03-03) |
| DSMR-reader | 10.50.0.143, REST API v2, token as used by `~/html/api/dsmr.php` on dockermac-1 | Meter counters: import T1/T2, export T1/T2, 3 phases, gas | Day statistics; depth to be checked (open point 1) |
| SolarEdge | `monitoringapi.solaredge.com`, site 181945, key in `~/tesla/.env` (`SOLAREDGE_API_KEY`) on dockermac-1 | Production per month | Since 28 Oct 2015; about 3,500–4,500 kWh a year |

Plug names and rooms are in `http://10.50.0.147:8000/pw-control.json`.

## 1. Items, rooms, relations

- **Rooms.** In house 2 "Thuis RT", create Hal, Badkamer, Slaapkamer Rick, Slaapkamer Carmen, Slaapkamer Ricardo, Berging and Strijkkamer, with floor empty (`rooms.ensure`). Kantoor, Keuken, Washok and Woonkamer already exist.
- **Plug items (29).**
  - Name "Plugwise – <Plugwise name>", in the plug's Plugwise room, `verificationStatus: "confirmed"`.
  - Attributes: `role: "meter"`, `meter_kind: "plug"`, `brand: "Plugwise"`, `model: "Circle"` or `"Circle+"`, and `mac` (the 16-character Circle address).
  - The Circle+ coordinator measures nothing and gets no energy rows.
- **Grid meter.** "Slimme meter", in the Meterkast. `role: "meter"`, `meter_kind: "grid"`. rpi-dsmr (#200) is the Pi that reads it; it stays an `sbc`.
- **Inverter.** "SolarEdge omvormer", in the Washok. `role: "meter"`, `meter_kind: "solar"`, `brand: "SolarEdge"`, `solaredge_site: "181945"`.
- **New relation type `powers`:** `fromItemId` = a plug, `toItemId` = an item it powers. A plug powers zero, one or several items.
  - Initial links: the Espresso plug (000D6F0002786CEF) → #53 Espresso Apparaat Krups, and the Vaatwasser plug (000D6F00004BE875) → #56 AEG built-in dishwasher.
  - The Printer plug gets no link.
- **The setup is idempotent.** It finds rooms and items by name and `mac` before creating them. It checks `items.listRelations({ type: "powers" })` before adding a link, because `items.addRelation` does not dedupe.
- **Clean-up.** The `energy.kwh_2025`, `energy.avg_w_2025`, `energy.days_2025` and `energy.meter` keys come off #53 and #56 (they are already gone from #8). Their text in AGENTS.md goes too: it is the tail of the Computer Lab line.
  - That text wrongly says the Data Tracker writes these keys. declutter-flow wrote them once by hand on 4 Oct, and `homebase-map.json` has no energy entries.
  - The removal comes after the Workbench Energy section (§7) ships and the plug rows are in, so #53 and #56 never lose their numbers in the UI.
- **New AGENTS.md terms:**
  - role `meter`;
  - plain keys `meter_kind` (`plug`, `grid` or `solar`) and `solaredge_site`;
  - relation `powers`.
- **Role lists.** `meter` joins Flow's `ROLES` list (`{ value: "meter", label: "Meter" }`) and the Workbench role options. `DATA_ROLES` and `BACKUP_ROLES` stay unchanged: a meter holds no personal data and receives no backups.

## 2. Tables

This follows the storage tables (migrations 0007/0008):
- camelCase column names;
- a serial `id` plus a unique index;
- `itemId` as `bigint unsigned` (mode number), with no declared foreign key.

The migration is 0009.

`energy_months` (unique index `em_item_month_uq` on `itemId`, `month`): one row per meter item per month.

| Column | Type | Meaning |
|---|---|---|
| `id` | serial | |
| `itemId` | bigint unsigned, not null | the meter item |
| `month` | char(7), not null | `YYYY-MM`, local time |
| `kwhNormal` | decimal(10,3) null | use (plug) or grid import, normal rate |
| `kwhOffpeak` | decimal(10,3) null | the same, off-peak rate |
| `kwhReturnedNormal` | decimal(10,3) null | grid export, normal (grid only) |
| `kwhReturnedOffpeak` | decimal(10,3) null | grid export, off-peak (grid only) |
| `kwhProduced` | decimal(10,3) null | production (solar only) |
| `avgW` | decimal(8,1) null | average power over the measured hours (plugs) |
| `baseW` | decimal(8,1) null | baseline load: the 10th percentile of the 15-minute averages (plugs) |
| `peakW` | decimal(8,1) null | highest 15-minute maximum (plugs) |
| `hours` | decimal(6,1) null | hours with data in the month |
| `source` | varchar(32), not null, default `"collector"` | e.g. `plugwise`, `dsmr`, `solaredge` |
| `measuredAt` | timestamp, not null, default now | set on every report that writes the row |
| `createdAt` | timestamp, not null, default now | |

For a grid meter, `kwhNormal` is meter counter T2 (normal) and `kwhOffpeak` is T1 (low).

`energy_tariffs` (unique index on `validFrom`): one row per price period.

| Column | Type | Meaning |
|---|---|---|
| `id` | serial | |
| `validFrom` | date, not null | the period starts here and runs until the next row |
| `normalEurKwh` | decimal(7,5) | import, normal |
| `offpeakEurKwh` | decimal(7,5) | import, off-peak |
| `feedInEurKwh` | decimal(7,5) | paid for export |
| `feedInCostEurKwh` | decimal(7,5) | charged for export |
| `fixedEurDay` | decimal(6,3) | fixed delivery and network costs per day |
| `note` | varchar(128) null | |
| `createdAt` / `updatedAt` | timestamp | |

The seed row has `validFrom` 2015-01-01, 0.24395, 0.24395, 0.06050, 0.03993 and 1.510 (€0.20 delivery + €1.31 Liander per day), with the note "contract prices 2026; older prices unknown". Until Rick adds older rows, older months are costed at today's price.

Drizzle returns decimal columns as strings. `api/lib/energy.ts` converts them to numbers before anything uses them, and every reader gets numbers.

## 3. Interface (`energy` router)

- **`energy.report({ itemId, source, months })`**
  - `source` is at most 32 characters.
  - `months` holds 1–200 entries of `{ month, kwhNormal?, kwhOffpeak?, kwhReturnedNormal?, kwhReturnedOffpeak?, kwhProduced?, avgW?, baseW?, peakW?, hours? }`. Every number is zod `number().nonnegative().finite()`, and `month` matches `^\d{4}-\d{2}$`.
  - Fields follow the item's `meter_kind`:

    | `meter_kind` | Required | Optional | Forbidden |
    |---|---|---|---|
    | `plug` | `kwhNormal`, `kwhOffpeak` | `avgW`, `baseW`, `peakW`, `hours` | returned, produced |
    | `grid` | `kwhNormal`, `kwhOffpeak`, `kwhReturnedNormal`, `kwhReturnedOffpeak` | `hours` | `kwhProduced`, `avgW`, `baseW`, `peakW` |
    | `solar` | `kwhProduced` | `hours` | everything else |

  - It upserts by (`itemId`, `month`) in one transaction, sets `measuredAt`, and never deletes.
  - The whole report is refused through an `EnergyReportError` → BAD_REQUEST, as storage does, if:
    - the item is missing or archived, or is not `role: "meter"` with a known `meter_kind`;
    - a field breaks the `meter_kind` rules above;
    - a month repeats within the report;
    - a month lies after the current month (local time).
  - It writes **no item event**: these are measurements, not edits, and a nightly report would otherwise add 31 events a night. The AGENTS.md contract bullet states that reason. It follows the existing rule that live meter data is read-only and skips the confirm step.
- **`energy.overview({ houseId? })`**
  - It is scoped like `storage.overview`: the `houseId` input, else the session house, and active items only. The house block uses only the grid meter, inverter and plugs of that same house.
  - It returns, for the last 12 complete months:
  - **House:**
    - use, production, import and export;
    - not measured (use minus all plugs);
    - net cost and fixed costs;
    - the baseline load of all plugs, in watts and in euros per year.
  - **Per plug:**
    - item, room, kWh, euros, average, baseline and peak watts;
    - baseline euros per year;
    - hours measured and hours possible;
    - trend percentage, and the items it powers.
  - **Per room:** kWh and euros.
  - The current tariff.
- **`energy.forItem({ itemId })`** works for a plug, or for an item a plug powers. It returns the plug, the other items on the same plug, and the last 24 months with kWh, euros and hours.
  - For an item that is neither, it returns `{ plug: null, sharedWith: [], months: [] }`.
  - NOT_FOUND is only for an item id that does not exist.
- **`energy.setTariff({ validFrom, normal, offpeak, feedIn, feedInCost, fixedPerDay, note? })`** upserts by `validFrom` and logs an event, because it is Rick's edit (like `storage.setRole`).

## 4. Calculations

- **Collector, per plug and month,** over the 15-minute rows:
  - kWh = Σ `avg_power_w` × 0.25 h / 1000, split into normal and off-peak by each row's local start time;
  - `hours` = number of rows × 0.25;
  - `avgW` = kWh × 1000 / hours;
  - `baseW` = 10th percentile of `avg_power_w`;
  - `peakW` = max `max_power_w`.
- **Price of a month:** the tariff row with the latest `validFrom` on or before the month's first day. Cost = `kwhNormal` × normal + `kwhOffpeak` × off-peak.
- **Baseline cost per year** = `baseW` / 1000 × 8,760 h × (0.476 × normal + 0.524 × off-peak). 88 of the week's 168 hours are off-peak.
- **Trend** = (last 12 months − the 12 before) / the 12 before. It is shown only when both windows have at least 80% of their hours measured.
- **House:**
  - use = import (normal + off-peak) + production − export (normal + off-peak);
  - not measured = use − Σ plugs;
  - net cost = import cost − export × (feed-in − feed-in cost) + `fixedEurDay` × days.
  - Each is shown for a month only when all its inputs have that month.

## 5. Collectors (dockermac-1)

- **`~/plugwise/report_energy_homebase.py`**
  - It finds plug items by `role: "meter"` and `mac` through `items.listAll`, and aggregates months from the history DB.
  - It sends the previous and the current month per plug.
  - `cron_full_energy_sync.sh` calls it at the end, after processing.
  - `--all` sends every month from 2020 onward; `--dry-run` prints the payloads and sends nothing.
- **`~/plugwise/report_house_energy.py`**
  - From DSMR-reader day statistics it sends import and export T1/T2 per month for the grid meter item.
  - From SolarEdge `energy?timeUnit=MONTH` it sends production for the inverter item.
  - It runs nightly at about 01:40, with `--all` (from 2015-10) and `--dry-run`.
  - It reads the DSMR token and the SolarEdge key at runtime from their existing files, never copies or prints them, and makes a few SolarEdge requests a night (the limit is 300 a day).
- **Errors.** A failing plug or source is logged and skipped, and the next night tries again. HomeBase is `http://10.50.0.102:3001`.

## 6. Flow lens

- **Header.** A second lens button, "⚡ Energy", next to "Lab". One lens is active at a time, and tapping the active one turns it off. `LensKey` becomes `"lab" | "energy"`, still stored per browser.
- **Find, with the Energy lens on:**
  - **House summary:** use and production over 12 months, net cost, the plugs' total baseline (watts and euros a year), "Not on a plug", and the price ("€0.244 per kWh"; tapping it adds a price from a date).
  - **Top consumers:** plugs by euros over 12 months.
  - **Baseline load:** plugs by baseline watts, with euros a year.
  - **Per room:** a bar per room over 12 months.
- **Card of a plug or a powered item:**
  - kWh and euros over 12 months, baseline and peak watts;
  - a 24-month kWh line;
  - the trend;
  - "via plug X" and "shared with …";
  - "measured X of Y hours" when there are gaps.
- **Linking.** "Powers…" on a plug's card searches items and links or unlinks them (`items.addRelation` / `items.removeRelation`, type `powers`).
- Sort and Act are unchanged.

## 7. Workbench

A read-only "Energy" section on the item page of a plug or powered item, using `energy.forItem`:
- kWh and euros over 12 months, baseline watts and the trend;
- a line "measured X of Y hours" when the 12 months have gaps.

The section is hidden when `forItem` returns `plug: null`. For a plug without rows yet it shows "No energy data yet".

## 8. Who builds what, and in what order

1. **declutter-main:**
   - tables and migration 0009, the `energy` router;
   - AGENTS.md terms and the contract bullet;
   - `meter` in the Workbench role options.

   Additive: test database first, then live, then tell Rick.
2. **declutter-flow:**
   - one-off setup: rooms, 31 meter items and 2 `powers` links;
   - a dry-run list for Rick before the real run.
3. **declutter-flow:** both collectors. Dry run, then `--all`, then nightly.
4. **declutter-flow:** the Flow lens (`src/flow`).
5. **declutter-main:** the Workbench section.
6. **After steps 3 and 5:**
   - declutter-flow removes the `energy.*` keys from #53 and #56;
   - declutter-main removes their text from AGENTS.md.

## 9. Testing

- Router tests on the test database, never the live one: upsert, refusals, and overview figures from fixture rows (including price periods, gaps and shared plugs).
- Unit tests for the calculations: off-peak split, baseline percentile, trend coverage rule, house use and net cost.
- A collector `--dry-run` against the real sources, checked by hand against today's figures. Plugwise 2025: 2,881 kWh over 28 plugs. SolarEdge 2025: 4,465 kWh.
- Rick checks the lens on his phone.

## Out of scope

- Part B: groups, phases and sockets.
- Part C: live readings.
- Gas.
- A Workbench energy page.
- Public holidays in off-peak.
- Splitting a shared plug's use over its items.

## Open points

1. **DSMR history depth.** How far back DSMR-reader's day statistics go is still unknown. If they start later than 2015, house use and "Not on a plug" start there; production and plugs keep their own history.
2. **Older prices.** Contract prices before 2026 are unknown. Rick can add them later with `setTariff`.
