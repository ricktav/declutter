import { useMemo, useState } from "react";
import { Undo2 } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import type { ItemDecision } from "@db/schema";
import { useFlow } from "./context";
import { DecisionButtons, EmptyState, ErrorLine, Photo, Ring, Sheet } from "./ui";
import { DECISIONS, isDecided, isReal, needsCheck, needsDecision, placeLabel, type FlowItem } from "./data";

const NO_ROOM = "__none__";

/** Decide what happens to each thing - later, in short sprints, when you are ready. */
export function ActTab() {
  const { items, houses, here, ready, refresh } = useFlow();
  const [houseId, setHouseId] = useState<number | "all">(here.houseId ?? "all");
  const [room, setRoom] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [last, setLast] = useState<{ id: number; prev: ItemDecision | null; name: string } | null>(null);
  const [listOpen, setListOpen] = useState<ItemDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setDecision = trpc.items.setDecision.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });

  // everything that counts for this house: real, checked things - including
  // the ones already gone, so the ring keeps their progress
  const inHouse = useMemo(
    () => items.filter((it) => isReal(it) && !needsCheck(it) && (houseId === "all" || it.houseId === houseId)),
    [items, houseId],
  );
  const rooms = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of inHouse) if (it.status === "active") m.set(it.room || NO_ROOM, (m.get(it.room || NO_ROOM) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [inHouse]);

  const scope = inHouse.filter((it) => room == null || (it.room || NO_ROOM) === room);
  const total = scope.filter((it) => it.status === "active" || isDecided(it)).length;
  const done = scope.filter(isDecided).length;
  const queue = scope.filter(needsDecision);
  const ordered = [...queue.filter((it) => !skipped.includes(it.id)), ...queue.filter((it) => skipped.includes(it.id))];
  const current = ordered[0];

  const lists = DECISIONS.filter((d) => d.key === "sell" || d.key === "donate" || d.key === "toss").map((d) => ({
    ...d,
    items: inHouse.filter((it) => it.status === "active" && it.decision === d.key),
  }));

  const decide = (it: FlowItem, d: ItemDecision) => {
    setError(null);
    setLast({ id: it.id, prev: it.decision ?? null, name: it.name });
    setDecision.mutate({ id: it.id, decision: d });
  };

  if (!ready) return <p className="py-10 text-center text-[13px] text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-1 px-1">
        {[{ id: "all" as const, name: "All houses" }, ...houses].map((h) => (
          <button
            key={h.id}
            onClick={() => {
              setHouseId(h.id);
              setRoom(null);
            }}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-[13px]",
              houseId === h.id ? "border-transparent bg-[#282c20] text-[#f4f4ed]" : "border-border bg-white",
            )}
          >
            {h.name}
          </button>
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-1 px-1">
        <button
          onClick={() => setRoom(null)}
          className={cn("shrink-0 rounded-full border px-3 py-1 text-[12px]", room == null ? "border-[#3C5D41] bg-[#3C5D41]/10" : "border-border bg-white")}
        >
          Every room
        </button>
        {rooms.map(([r, n]) => (
          <button
            key={r}
            onClick={() => setRoom(r)}
            className={cn("shrink-0 rounded-full border px-3 py-1 text-[12px]", room === r ? "border-[#3C5D41] bg-[#3C5D41]/10" : "border-border bg-white")}
          >
            {r === NO_ROOM ? "No room" : r} <span className="font-data opacity-60">{n}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-4 rounded-2xl bg-white p-3 border border-border">
        <Ring value={done} total={total} size={96} label="decided" />
        <div className="flex flex-1 flex-col gap-1.5">
          {lists.map((l) => (
            <button
              key={l.key}
              onClick={() => setListOpen(l.key)}
              disabled={l.items.length === 0}
              className="flex items-center justify-between rounded-lg border px-3 py-1.5 text-[13px] disabled:opacity-40"
              style={{ borderColor: l.color, color: l.color }}
            >
              <span className="font-semibold">{l.key === "sell" ? "Sell list" : l.key === "donate" ? "Donate box" : "Toss run"}</span>
              <span className="font-data">{l.items.length}</span>
            </button>
          ))}
        </div>
      </div>

      {last && (
        <button
          onClick={() => {
            setDecision.mutate({ id: last.id, decision: last.prev });
            setLast(null);
          }}
          className="flex items-center gap-2 self-center text-[12px] text-muted-foreground underline"
        >
          <Undo2 className="h-3.5 w-3.5" /> Undo "{last.name}"
        </button>
      )}

      <ErrorLine message={error} />

      {!current ? (
        <EmptyState title={total === 0 ? "No things here yet" : "Everything here is decided"}>
          {total === 0 ? "Snap and sort things first." : "Pick another room, or work through the lists above."}
        </EmptyState>
      ) : (
        <div key={current.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-3 shadow-sm">
          <Photo storageKey={current.imageKey} className="aspect-[4/3] w-full" />
          <div>
            <p className="text-[17px] font-semibold leading-tight">{current.name}</p>
            <p className="text-[12px] text-muted-foreground">
              {[current.areaName, placeLabel(current, houses) || "no place yet"].filter(Boolean).join(" · ")}
              {current.decision === "later" && " · was Later"}
            </p>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-data text-[15px] font-bold">Keep it?</span>
            <button onClick={() => setSkipped((s) => [...s.filter((x) => x !== current.id), current.id])} className="font-data text-[12px] text-muted-foreground underline">
              skip
            </button>
          </div>
          <DecisionButtons disabled={setDecision.isPending} onPick={(d) => decide(current, d)} />
          <p className="text-center font-data text-[12px] text-muted-foreground">{ordered.length} left to decide</p>
        </div>
      )}

      {listOpen && <DecisionList decision={listOpen} items={lists.find((l) => l.key === listOpen)?.items ?? []} onClose={() => setListOpen(null)} />}
    </div>
  );
}

/** Sell list / Donate box / Toss run - mark each thing gone once it has left the house. */
function DecisionList({ decision, items, onClose }: { decision: ItemDecision; items: FlowItem[]; onClose: () => void }) {
  const { houses, refresh } = useFlow();
  const archive = trpc.items.setArchived.useMutation({ onSuccess: refresh });
  const clear = trpc.items.setDecision.useMutation({ onSuccess: refresh });
  const title = decision === "sell" ? "Sell list" : decision === "donate" ? "Donate box" : "Toss run";
  return (
    <Sheet title={title} onClose={onClose}>
      {items.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">This list is empty.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 rounded-xl border border-border bg-white p-2">
              <Photo storageKey={it.imageKey} className="h-14 w-14 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-medium truncate">{it.name}</p>
                <p className="text-[11px] text-muted-foreground truncate">{placeLabel(it, houses) || "no place"}</p>
                <button onClick={() => clear.mutate({ id: it.id, decision: null })} className="text-[11px] text-muted-foreground underline">
                  undo decision
                </button>
              </div>
              <button
                onClick={() => archive.mutate({ id: it.id, archived: true })}
                disabled={archive.isPending}
                className="rounded-lg bg-[#282c20] px-3 py-2 font-data text-[12px] font-semibold text-[#f4f4ed] disabled:opacity-40"
              >
                Gone
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
