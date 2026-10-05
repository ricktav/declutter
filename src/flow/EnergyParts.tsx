import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { trpc } from "@/providers/trpc";
import { useFlow } from "./context";
import { Sheet } from "./ui";
import { euro } from "./data";
import { POWERS } from "./lenses";

/** The live dashboard on dockermac-1: plugs, smart meter and phases right now. */
const METERKAST_URL = "http://10.50.0.10/meterkast.html";

const kwh = (v: number | null | undefined) =>
  v == null ? "—" : `${Math.round(v).toLocaleString("nl-NL")} kWh`;
const eur = (v: number | null | undefined) => (v == null ? "—" : euro(v));

/** Find with the Energy lens on: the house, top consumers, baseline load, rooms. */
export function EnergyFind({ onOpen }: { onOpen: (itemId: number) => void }) {
  const o = trpc.energy.overview.useQuery({});
  const [priceOpen, setPriceOpen] = useState(false);
  if (!o.data)
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">
        Loading energy…
      </p>
    );
  const { house, plugs, rooms, tariff, months } = o.data;
  const top = plugs.filter(p => p.kwh > 0).slice(0, 10);
  const base = [...plugs]
    .filter(p => (p.baseW ?? 0) >= 1)
    .sort((a, b) => (b.baseW ?? 0) - (a.baseW ?? 0))
    .slice(0, 10);
  const maxRoom = Math.max(1, ...rooms.map(r => r.kwh));
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
              Used {kwh(house.useKwh)} · net cost {eur(house.netCostEur)}
            </p>
            <p className="tabular-nums text-muted-foreground">
              Not on a plug {kwh(house.unmeasuredKwh)}
              {house.monthsCounted < 12 &&
                ` · ${house.monthsCounted} of 12 months complete`}
            </p>
            {house.producedKwh != null && <SolarRows house={house} />}
          </>
        )}
        <p className="tabular-nums text-muted-foreground">
          Always on: {Math.round(house.baselineW)} W on the plugs ·{" "}
          {eur(house.baselineEurYear)} a year
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button
            onClick={() => setPriceOpen(true)}
            className="font-data text-[12px] text-[#3C5D41] underline"
          >
            {tariff
              ? `€${tariff.normal.toFixed(3)} per kWh${tariff.netMetering ? " · netting on" : ""}`
              : "Set a price per kWh"}
          </button>
          {/* live readings stay on the meterkast dashboard; this lens is history and cost */}
          <a
            href={METERKAST_URL}
            target="_blank"
            rel="noreferrer"
            className="font-data text-[12px] text-[#3C5D41] underline"
          >
            Live → meterkast ↗
          </a>
        </div>
      </section>

      <PlugList
        title="Top consumers (12 months)"
        rows={top}
        value={p => `${eur(p.eur)} · ${kwh(p.kwh)}`}
        onOpen={onOpen}
      />
      <PlugList
        title="Always on"
        rows={base}
        value={p => `${Math.round(p.baseW ?? 0)} W · ${eur(p.baseEurYear)}/yr`}
        onOpen={onOpen}
      />

      <section className="flex flex-col gap-1.5 rounded-xl border border-border bg-white p-3">
        <span className="micro-label text-muted-foreground">
          Per room (plugs)
        </span>
        {rooms.map(r => (
          <div
            key={String(r.roomId)}
            className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-[12px]"
          >
            <span className="truncate">{r.name}</span>
            <span
              className="h-2 rounded-full bg-[#2F7A45]/80"
              style={{ width: `${(r.kwh / maxRoom) * 100}%` }}
            />
            <span className="tabular-nums text-muted-foreground">
              {eur(r.eur)}
            </span>
          </div>
        ))}
      </section>

      {priceOpen && (
        <PriceSheet onClose={() => setPriceOpen(false)} current={tariff} />
      )}
    </div>
  );
}

type House = inferRouterOutputs<AppRouter>["energy"]["overview"]["house"];
const pct = (v: number | null | undefined) =>
  v == null ? "—" : `${Math.round(v)}%`;

/**
 * Where the solar power went and what was bought, the way the supplier
 * settles it: exported kWh net against bought kWh for the year (saldering,
 * until the price row turns netting off), export costs on every exported kWh.
 */
function SolarRows({ house }: { house: House }) {
  const rows: [string, string, boolean?][] = [
    ["Produced by the panels", kwh(house.producedKwh)],
    [
      "used directly",
      `${kwh(house.selfConsumedKwh)} · ${pct(house.selfConsumptionPct)}`,
      true,
    ],
    ["exported", kwh(house.exportKwh), true],
    ["Bought from the grid", kwh(house.importKwh)],
  ];
  if ((house.nettedKwh ?? 0) > 0) {
    rows.push(["netted against export", kwh(house.nettedKwh), true]);
    rows.push(["net bought", kwh(house.netImportKwh), true]);
  }
  if ((house.netExportKwh ?? 0) > 0)
    rows.push(["Exported beyond what you bought", kwh(house.netExportKwh)]);
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-2">
      <span className="micro-label text-muted-foreground">Solar</span>
      {rows.map(([label, value, sub]) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-2 tabular-nums"
        >
          <span className={sub ? "pl-3 text-muted-foreground" : ""}>
            {label}
          </span>
          <span className={sub ? "text-muted-foreground" : ""}>{value}</span>
        </div>
      ))}
      <p className="tabular-nums text-muted-foreground">
        Own solar covers {pct(house.coverageDirectPct)} of use directly
        {(house.nettedKwh ?? 0) > 0 &&
          ` · ${pct(house.coverageNettedPct)} with netting`}
      </p>
      <p className="tabular-nums text-muted-foreground">
        Export costs {eur(house.feedInCostEur)}
        {(house.feedInEur ?? 0) > 0 &&
          ` · feed-in paid ${eur(house.feedInEur)}`}
      </p>
    </div>
  );
}

type Plug =
  inferRouterOutputs<AppRouter>["energy"]["overview"]["plugs"][number];
function PlugList({
  title,
  rows,
  value,
  onOpen,
}: {
  title: string;
  rows: Plug[];
  value: (p: Plug) => string;
  onOpen: (id: number) => void;
}) {
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-border bg-white p-3">
      <span className="micro-label text-muted-foreground">{title}</span>
      {rows.length === 0 && (
        <p className="text-[13px] text-muted-foreground">No plug data yet.</p>
      )}
      {rows.map(p => (
        <button
          key={p.itemId}
          onClick={() => onOpen(p.itemId)}
          className="flex items-baseline gap-2 py-1 text-left text-[13px]"
        >
          <span className="min-w-0 flex-1 truncate">
            {p.name.replace(/^Plugwise – /, "")}
            <span className="text-muted-foreground">
              {" "}
              · {p.roomName ?? "no room"}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">{value(p)}</span>
        </button>
      ))}
    </section>
  );
}

/** The energy block on a thing's card: its plug's figures, a 24-month line, sharing and linking. */
export function EnergyCard({
  itemId,
  isPlug,
}: {
  itemId: number;
  isPlug: boolean;
}) {
  const e = trpc.energy.forItem.useQuery({ itemId });
  const [linkOpen, setLinkOpen] = useState(false);
  if (!e.data || (!e.data.plug && !isPlug)) return null;
  const { plug, summary, months, sharedWith } = e.data;
  const pts = months.map(m => m.kwh ?? 0);
  const max = Math.max(1, ...pts);
  const path = pts
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i / Math.max(1, pts.length - 1)) * 100},${30 - (v / max) * 28}`
    )
    .join(" ");
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-white p-3 text-[13px]">
      <span className="micro-label text-muted-foreground">Energy</span>
      {plug && plug.id !== itemId && (
        <p className="text-muted-foreground">via {plug.name}</p>
      )}
      {!summary ? (
        <p className="text-muted-foreground">No energy data yet.</p>
      ) : (
        <>
          <p className="tabular-nums">
            {kwh(summary.kwh)} · {eur(summary.eur)} in 12 months
            {summary.trendPct != null &&
              ` · ${summary.trendPct > 0 ? "+" : ""}${summary.trendPct}%`}
          </p>
          <p className="tabular-nums text-muted-foreground">
            Always on {summary.baseW ?? "—"} W · peak {summary.peakW ?? "—"} W
          </p>
          {summary.hours < summary.hoursPossible * 0.98 && (
            <p className="tabular-nums text-muted-foreground">
              Measured {Math.round(summary.hours)} of {summary.hoursPossible}{" "}
              hours
            </p>
          )}
          <svg
            viewBox="0 0 100 32"
            className="h-10 w-full"
            preserveAspectRatio="none"
            aria-label="kWh per month, last 24 months"
          >
            <path
              d={path}
              fill="none"
              stroke="#2F7A45"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </>
      )}
      {sharedWith.length > 0 && (
        <p className="text-muted-foreground">
          {isPlug ? "Powers" : "Shared with"}{" "}
          {sharedWith.map(x => x.name).join(", ")}
        </p>
      )}
      {isPlug && (
        <button
          onClick={() => setLinkOpen(true)}
          className="self-start text-[12px] text-[#3C5D41] underline"
        >
          Powers…
        </button>
      )}
      {linkOpen && plug && (
        <PowersPicker plugId={plug.id} onClose={() => setLinkOpen(false)} />
      )}
    </div>
  );
}

/** Link or unlink the things a plug powers. */
function PowersPicker({
  plugId,
  onClose,
}: {
  plugId: number;
  onClose: () => void;
}) {
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
    () =>
      new Map(
        (rels.data ?? [])
          .filter(r => r.fromItemId === plugId)
          .map(r => [r.toItemId, r.id])
      ),
    [rels.data, plugId]
  );
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items
      .filter(
        it =>
          it.status === "active" &&
          it.id !== plugId &&
          String(it.attributes?.role ?? "") !== "meter"
      )
      .filter(
        it =>
          linked.has(it.id) ||
          (t.length >= 2 && it.name.toLowerCase().includes(t))
      )
      .slice(0, 30);
  }, [items, q, plugId, linked]);
  return (
    <Sheet title="This plug powers…" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <input
          id="powers-search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search a thing"
          className="rounded-xl border border-input bg-white px-3 py-2 text-[16px]"
        />
        {hits.map(it => {
          const relId = linked.get(it.id);
          return (
            <label
              key={it.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-[14px]"
            >
              <input
                type="checkbox"
                checked={relId != null}
                disabled={add.isPending || remove.isPending}
                onChange={() =>
                  relId != null
                    ? remove.mutate({ id: relId })
                    : add.mutate({
                        fromItemId: plugId,
                        toItemId: it.id,
                        type: POWERS,
                      })
                }
              />
              {it.name}
            </label>
          );
        })}
        {hits.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            Type two letters to find a thing.
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** Add a price from a date onward. */
function PriceSheet({
  current,
  onClose,
}: {
  current: {
    normal: number;
    offpeak: number;
    feedIn: number;
    feedInCost: number;
    fixedPerDay: number;
    netMetering: boolean;
  } | null;
  onClose: () => void;
}) {
  // saldering: on until the law ends it (1 Jan 2027); a new price row turns it off
  const [netMetering, setNetMetering] = useState(current?.netMetering ?? true);
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
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(f.validFrom) &&
    nums.every(x => Number.isFinite(x) && x >= 0);
  return (
    <Sheet title="Price per kWh" onClose={onClose}>
      <div className="flex flex-col gap-2">
        {fields.map(([k, label]) => (
          <label
            key={k}
            className="flex items-center justify-between gap-2 text-[13px]"
          >
            {label}
            <input
              id={`price-${k}`}
              value={f[k]}
              inputMode={k === "validFrom" ? "text" : "decimal"}
              onChange={e => setF({ ...f, [k]: e.target.value })}
              className="w-36 rounded-lg border border-input px-2 py-1 text-right tabular-nums"
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-2 text-[13px]">
          Net metering (salderen)
          <input
            id="price-netMetering"
            type="checkbox"
            checked={netMetering}
            onChange={e => setNetMetering(e.target.checked)}
            className="h-4 w-4"
          />
        </label>
        <button
          disabled={!ok || set.isPending}
          onClick={() => {
            const [normal, offpeak, feedIn, feedInCost, fixedPerDay] = nums;
            set.mutate({
              validFrom: f.validFrom,
              normal,
              offpeak,
              feedIn,
              feedInCost,
              fixedPerDay,
              netMetering,
            });
          }}
          className="mt-1 rounded-xl bg-[#282c20] py-2.5 text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
        >
          Save price
        </button>
        {set.error && (
          <p className="text-[12px] text-[#AD432B]">{set.error.message}</p>
        )}
      </div>
    </Sheet>
  );
}
