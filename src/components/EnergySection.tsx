import { trpc } from "@/providers/trpc";
import { METERKAST_URL } from "@/components/Layout";

const EUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Read-only energy figures for a plug or an item a plug powers. Hidden for anything else. */
export function EnergySection({ itemId }: { itemId: number }) {
  const q = trpc.energy.forItem.useQuery({ itemId });
  const e = q.data;
  if (q.isError) return <p className="text-[13px] text-muted-foreground">Energy: could not load ({q.error.message})</p>;
  if (!e || !e.plug) return null;
  const s = e.summary;
  return (
    <section className="rounded-lg border border-border bg-white p-4">
      <div className="flex items-center mb-2">
        <h2 className="micro-label text-muted-foreground">Energy</h2>
        <span className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          {e.plug.id !== itemId && <span>via {e.plug.name}</span>}
          <a href={METERKAST_URL} target="_blank" rel="noreferrer" className="underline" title="Live readings on the meterkast dashboard">
            Live ↗
          </a>
        </span>
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
