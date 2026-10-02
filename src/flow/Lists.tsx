import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import type { ItemDecision } from "@db/schema";
import { useFlow } from "./context";
import { ErrorLine, Photo, Sheet } from "./ui";
import { SafetyChecklist } from "./LabParts";
import { DONATE_TO, LIST_TITLE, SELL_CHANNELS, SELL_KEYS, euro, num, placeLabel, type FlowItem } from "./data";
import { holdsData, roleLabel, role, safeToGo, shortDate, today } from "./lenses";

/**
 * Sell list / Donate box / Toss run. Each thing gets marked Gone once it has
 * left the house; a device that holds data must pass its three checks first.
 * Gone things stay below, so a mistake is one tap to restore.
 */
export function DecisionList({
  decision,
  items,
  gone,
  onClose,
}: {
  decision: ItemDecision;
  items: FlowItem[];
  gone: FlowItem[];
  onClose: () => void;
}) {
  const [showGone, setShowGone] = useState(items.length === 0);
  const a = (it: FlowItem, k: string) => it.attributes?.[k];

  const totals =
    decision === "sell"
      ? [
          { label: "To list", value: String(items.filter((it) => !a(it, SELL_KEYS.listedAt)).length) },
          { label: "Listed", value: String(items.filter((it) => a(it, SELL_KEYS.listedAt)).length) },
          { label: "Asking", value: euro(items.reduce((s, it) => s + (num(a(it, SELL_KEYS.askPrice)) ?? 0), 0)) },
          { label: "Sold", value: euro(gone.reduce((s, it) => s + (num(a(it, SELL_KEYS.soldPrice)) ?? 0), 0)) },
        ]
      : null;

  return (
    <Sheet title={LIST_TITLE[decision]} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {totals && (
          <div className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-white p-2">
            {totals.map((t) => (
              <div key={t.label} className="flex flex-col items-center">
                <span className="font-data text-[15px] font-bold tabular-nums">{t.value}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.label}</span>
              </div>
            ))}
          </div>
        )}

        {items.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-muted-foreground">Nothing left on this list.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it) => (
              <ListRow key={it.id} item={it} decision={decision} />
            ))}
          </ul>
        )}

        {gone.length > 0 && (
          <div className="flex flex-col gap-2">
            <button onClick={() => setShowGone((s) => !s)} className="flex items-center gap-1 self-start font-data text-[13px] font-semibold">
              {showGone ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {decision === "sell" ? "Sold" : "Gone"} <span className="font-normal text-muted-foreground">{gone.length}</span>
            </button>
            {showGone && (
              <ul className="flex flex-col gap-1.5">
                {gone.map((it) => (
                  <GoneRow key={it.id} item={it} decision={decision} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Save-on-blur text field for one attribute key. */
function AttrInput({
  item,
  attrKey,
  placeholder,
  numeric,
  prefix,
  label,
}: {
  item: FlowItem;
  attrKey: string;
  placeholder?: string;
  numeric?: boolean;
  prefix?: string;
  label: string;
}) {
  const { refresh } = useFlow();
  const saved = String(item.attributes?.[attrKey] ?? "");
  const [v, setV] = useState(saved);
  const patch = trpc.items.patchAttributes.useMutation({ onSuccess: refresh });
  const save = () => {
    const t = v.trim();
    if (t === saved) return;
    const n = numeric ? num(t.replace(",", ".")) : null;
    patch.mutate({ id: item.id, set: { [attrKey]: t === "" ? null : numeric && n != null ? Math.round(n) : t } });
  };
  return (
    <label className="flex items-center gap-1 rounded-lg border border-input bg-white px-2 focus-within:border-[#3C5D41]">
      {prefix && <span className="text-[13px] text-muted-foreground">{prefix}</span>}
      <input
        id={`attr-${item.id}-${attrKey}`}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        inputMode={numeric ? "decimal" : undefined}
        placeholder={placeholder}
        aria-label={label}
        className="w-full min-w-0 bg-transparent py-1.5 text-[14px] outline-none"
      />
    </label>
  );
}

function ListRow({ item, decision }: { item: FlowItem; decision: ItemDecision }) {
  const { houses, backups, refresh } = useFlow();
  const [soldOpen, setSoldOpen] = useState(false);
  const [soldPrice, setSoldPrice] = useState(String(item.attributes?.[SELL_KEYS.askPrice] ?? ""));
  const [error, setError] = useState<string | null>(null);
  const onError = (e: { message: string }) => setError(e.message);
  const patch = trpc.items.patchAttributes.useMutation({ onSuccess: refresh, onError });
  const archive = trpc.items.setArchived.useMutation({ onSuccess: refresh, onError });
  const clear = trpc.items.setDecision.useMutation({ onSuccess: refresh, onError });

  const a = (k: string) => item.attributes?.[k];
  const dataDevice = holdsData(item);
  const safe = safeToGo(item, backups);
  const listedAt = a(SELL_KEYS.listedAt);
  const channel = String(a(SELL_KEYS.channel) ?? "");
  const busy = patch.isPending || archive.isPending;

  const markSold = async () => {
    setError(null);
    const n = num(soldPrice.trim().replace(",", "."));
    try {
      await patch.mutateAsync({ id: item.id, set: { [SELL_KEYS.soldPrice]: n != null ? Math.round(n) : null, [SELL_KEYS.soldAt]: today() } });
      await archive.mutateAsync({ id: item.id, archived: true });
    } catch {
      // onError already shows the message
    }
  };

  const goneButton = (
    <button
      onClick={() => archive.mutate({ id: item.id, archived: true })}
      disabled={busy || !safe}
      className="rounded-lg bg-[#282c20] px-3 py-2 font-data text-[12px] font-semibold text-[#f4f4ed] disabled:opacity-40"
    >
      Gone
    </button>
  );

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-white p-2">
      <div className="flex items-center gap-3">
        <Photo storageKey={item.imageKey} className="h-14 w-14 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{item.name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {[role(item) && roleLabel(role(item)), placeLabel(item, houses) || "no place"].filter(Boolean).join(" · ")}
          </p>
          <button onClick={() => clear.mutate({ id: item.id, decision: null })} className="text-[11px] text-muted-foreground underline">
            undo decision
          </button>
        </div>
        {decision !== "sell" && goneButton}
      </div>

      {decision === "donate" && <AttrInput item={item} attrKey={DONATE_TO} label="Donate to" placeholder="To: Kringloop, a friend, school…" />}

      {decision === "sell" && (
        <>
          <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <AttrInput item={item} attrKey={SELL_KEYS.askPrice} label="Asking price in euros" prefix="€" placeholder="price" numeric />
            <div className="-mr-2 flex gap-1 overflow-x-auto pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {SELL_CHANNELS.map((c) => (
                <button
                  key={c}
                  disabled={busy}
                  onClick={() => patch.mutate({ id: item.id, set: { [SELL_KEYS.channel]: c === channel ? null : c } })}
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 text-[12px]",
                    c === channel ? "border-[#9E6A08] bg-[#9E6A08] text-white" : "border-border bg-white text-muted-foreground",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {listedAt ? (
              <p className="flex-1 text-[12px] text-[#9E6A08]">
                Listed{channel && ` on ${channel}`} · {shortDate(listedAt)}{" "}
                <button onClick={() => patch.mutate({ id: item.id, set: { [SELL_KEYS.listedAt]: null } })} className="text-muted-foreground underline">
                  unlist
                </button>
              </p>
            ) : (
              <button
                disabled={busy}
                onClick={() => patch.mutate({ id: item.id, set: { [SELL_KEYS.listedAt]: today() } })}
                className="flex-1 rounded-lg border border-[#9E6A08] py-2 font-data text-[12px] font-semibold text-[#9E6A08] disabled:opacity-40"
              >
                Mark listed
              </button>
            )}
            <button
              disabled={busy || !safe}
              onClick={() => setSoldOpen((o) => !o)}
              className="rounded-lg bg-[#282c20] px-4 py-2 font-data text-[12px] font-semibold text-[#f4f4ed] disabled:opacity-40"
            >
              Sold
            </button>
          </div>
          {soldOpen && safe && (
            <div className="flex items-center gap-2 rounded-lg bg-[#9E6A08]/10 p-2">
              <span className="text-[13px]">Sold for €</span>
              <input
                id={`sold-${item.id}`}
                value={soldPrice}
                onChange={(e) => setSoldPrice(e.target.value)}
                inputMode="decimal"
                autoFocus
                aria-label="Sold price in euros"
                className="w-20 rounded-md border border-input bg-white px-2 py-1.5 text-[14px]"
              />
              <button
                disabled={busy}
                onClick={markSold}
                className="ml-auto rounded-lg bg-[#9E6A08] px-3 py-2 font-data text-[12px] font-semibold text-white disabled:opacity-40"
              >
                {busy ? "Saving…" : "Sold, it's gone"}
              </button>
            </div>
          )}
        </>
      )}

      {dataDevice && <SafetyChecklist item={item} />}
      <ErrorLine message={error} />
    </li>
  );
}

function GoneRow({ item, decision }: { item: FlowItem; decision: ItemDecision }) {
  const { refresh } = useFlow();
  const restore = trpc.items.setArchived.useMutation({ onSuccess: refresh });
  const patch = trpc.items.patchAttributes.useMutation();
  const a = (k: string) => item.attributes?.[k];
  const sold = num(a(SELL_KEYS.soldPrice));
  const detail =
    decision === "sell"
      ? [sold != null ? euro(sold) : "price not noted", shortDate(a(SELL_KEYS.soldAt))].filter(Boolean).join(" · ")
      : decision === "donate"
        ? a(DONATE_TO)
          ? `to ${a(DONATE_TO)}`
          : ""
        : "";
  return (
    <li className="flex items-center gap-3 rounded-lg bg-white/70 px-2 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{item.name}</span>
        {detail && <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>}
      </span>
      <button
        disabled={restore.isPending}
        onClick={async () => {
          // restoring a sale undoes the sale; the asking price and channel stay
          if (decision === "sell") await patch.mutateAsync({ id: item.id, set: { [SELL_KEYS.soldPrice]: null, [SELL_KEYS.soldAt]: null } });
          restore.mutate({ id: item.id, archived: false });
        }}
        className="text-[12px] text-muted-foreground underline"
      >
        restore
      </button>
    </li>
  );
}
