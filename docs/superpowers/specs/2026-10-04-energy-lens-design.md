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
- **Clean-up.** Once their plugs carry data, the `energy.kwh_2025`, `energy.avg_w_2025`, `energy.days_2025` and `energy.meter` keys come off #53 and #56 (they are already gone from #8), and their AGENTS.md bullet is removed.
- **New AGENTS.md terms:** role `meter`, plain key `meter_kind` (`plug`, `grid` or `solar`), and relation `powers`. Flow's `ROLES` list gains `{ value: "meter", label: "Meter" }`.

## 2. Tables

`energy_months`: one row per meter item per month.

| Column | Type | Meaning |
|---|---|---|
| `item_id` | int, FK items | the meter item |
| `month` | char(7) | `YYYY-MM`, local time |
| `kwh_normal` | decimal(10,3) | use (plug) or grid import, normal rate |
| `kwh_offpeak` | decimal(10,3) | the same, off-peak rate |
| `kwh_returned_normal` | decimal(10,3) null | grid export, normal (grid only) |
| `kwh_returned_offpeak` | decimal(10,3) null | grid export, off-peak (grid only) |
| `kwh_produced` | decimal(10,3) null | production (solar only) |
| `avg_w` | decimal(8,1) null | average power over the measured hours (plugs) |
| `base_w` | decimal(8,1) null | baseline load: the 10th percentile of the 15-minute averages (plugs) |
| `peak_w` | decimal(8,1) null | highest 15-minute maximum (plugs) |
| `hours` | decimal(6,1) null | hours with data in the month |
| `source` | varchar(32) | e.g. `plugwise`, `dsmr`, `solaredge` |
| `updated_at` | timestamp | |

The primary key is (`item_id`, `month`). For a grid meter, `kwh_normal` is meter counter T2 (normal) and `kwh_offpeak` is T1 (low).

`energy_tariffs`: one row per price period.

| Column | Type | Meaning |
|---|---|---|
| `valid_from` | date, PK | the period starts here and runs until the next row |
| `normal_eur_kwh` | decimal(7,5) | import, normal |
| `offpeak_eur_kwh` | decimal(7,5) | import, off-peak |
| `feed_in_eur_kwh` | decimal(7,5) | paid for export |
| `feed_in_cost_eur_kwh` | decimal(7,5) | charged for export |
| `fixed_eur_day` | decimal(6,3) | fixed delivery and network costs per day |
| `note` | varchar(128) null | |

The seed row has `valid_from` 2015-01-01, 0.24395, 0.24395, 0.06050, 0.03993 and 1.510 (€0.20 delivery + €1.31 Liander per day), with the note "contract prices 2026; older prices unknown". Until Rick adds older rows, older months are costed at today's price.

## 3. Interface (`energy` router)

- **`energy.report({ itemId, source, months })`**
  - `source` is at most 32 characters; `months` holds 1–200 entries of `{ month, kwhNormal, kwhOffpeak, kwhReturnedNormal?, kwhReturnedOffpeak?, kwhProduced?, avgW?, baseW?, peakW?, hours? }`.
  - It upserts by (`itemId`, `month`) and never deletes.
  - The whole report is refused with BAD_REQUEST if the item is missing, archived or not `role: "meter"`, any value is negative, a month is malformed, or a month lies after the current one.
  - It writes **no item event**: these are measurements, not edits. A nightly report would otherwise add 31 events a night. This follows AGENTS.md: live meter data is read-only and skips the confirm step.
- **`energy.overview({ houseId? })`** returns, for the last 12 complete months:
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
- **`energy.setTariff({ validFrom, normal, offpeak, feedIn, feedInCost, fixedPerDay, note? })`** upserts by `validFrom`.

## 4. Calculations

- **Collector, per plug and month,** over the 15-minute rows:
  - kWh = Σ `avg_power_w` × 0.25 h / 1000, split into normal and off-peak by each row's local start time;
  - `hours` = number of rows × 0.25;
  - `avg_w` = kWh × 1000 / hours;
  - `base_w` = 10th percentile of `avg_power_w`;
  - `peak_w` = max `max_power_w`.
- **Price of a month:** the tariff row with the latest `valid_from` on or before the month's first day. Cost = `kwh_normal` × normal + `kwh_offpeak` × off-peak.
- **Baseline cost per year** = `base_w` / 1000 × 8,760 h × (0.476 × normal + 0.524 × off-peak). 88 of the week's 168 hours are off-peak.
- **Trend** = (last 12 months − the 12 before) / the 12 before. It is shown only when both windows have at least 80% of their hours measured.
- **House:**
  - use = import (normal + off-peak) + production − export (normal + off-peak);
  - not measured = use − Σ plugs;
  - net cost = import cost − export × (feed-in − feed-in cost) + `fixed_eur_day` × days.
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

A read-only "Energy" section on the item page of a plug or powered item: kWh and euros over 12 months, baseline watts and the trend, using `energy.forItem`.

## 8. Who builds what, and in what order

1. **declutter-main:** tables and migration, the `energy` router, AGENTS.md terms and the contract bullet. Additive: test database first, then live, then tell Rick.
2. **declutter-flow:**
   - one-off setup: rooms, 31 meter items and 2 `powers` links;
   - a dry-run list for Rick before the real run.
3. **declutter-flow:** both collectors. Dry run, then `--all`, then nightly.
4. **declutter-flow:** the Flow lens (`src/flow`).
5. **declutter-main:** the Workbench section, and removing the `energy.*` keys from AGENTS.md once step 3 has data.

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
