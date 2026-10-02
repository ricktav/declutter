import { useMemo, useState } from "react";
import { Search, ExternalLink } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { ItemRoomPreview } from "@/components/ItemRoomPreview";
import { useFlow } from "./context";
import { DecisionBadge, DecisionButtons, EmptyState, Photo, Sheet } from "./ui";
import { BackupPicker, LabFields, SafetyChecklist } from "./LabParts";
import { isReal, placeLabel, type FlowItem } from "./data";
import { holdsData, inLab, role, roleLabel } from "./lenses";

/** "Where is it?" - type a word, see the place and a photo. */
export function FindTab() {
  const { items, houses, lens, ready } = useFlow();
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const results = useMemo(() => {
    const live = items.filter((it) => it.status === "active" && isReal(it) && (lens !== "lab" || inLab(it)));
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return live.slice(0, 20);
    return live
      .filter((it) => {
        // attribute values too, so a hostname, an IP or a serial number finds its thing
        const hay = [
          it.name,
          it.description,
          it.room,
          it.floor,
          it.areaName,
          houses.find((h) => h.id === it.houseId)?.name,
          ...Object.values(it.attributes ?? {}),
          role(it) && roleLabel(role(it)),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, 60);
  }, [items, houses, q, lens]);
  const open = items.find((it) => it.id === openId) ?? null;

  if (!ready) return <p className="py-10 text-center text-[13px] text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 rounded-xl border border-input bg-white px-3 py-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          id="flow-find"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={lens === "lab" ? "Search a device, hostname, IP or serial" : "Search a thing, a room or a kind"}
          className="flex-1 bg-transparent text-[16px] outline-none"
        />
      </label>
      {!q && <span className="micro-label text-muted-foreground">Recently changed</span>}

      {results.length === 0 ? (
        <EmptyState title="Nothing found">Try a shorter word, a room name or a kind such as "cable".</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map((it) => (
            <li key={it.id}>
              <button onClick={() => setOpenId(it.id)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-white p-2 text-left">
                <Photo storageKey={it.imageKey} className="h-14 w-14 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-medium">{it.name}</span>
                    <DecisionBadge decision={it.decision} />
                  </span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {[role(it) && roleLabel(role(it)), it.attributes?.model, placeLabel(it, houses) || "no place yet"].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <ThingSheet item={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ThingSheet({ item, onClose }: { item: FlowItem; onClose: () => void }) {
  const { houses, lens, refresh } = useFlow();
  const setDecision = trpc.items.setDecision.useMutation({ onSuccess: refresh });
  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {item.imageKey && <Photo storageKey={item.imageKey} className="aspect-[4/3] w-full" />}
        <div className="rounded-xl bg-white border border-border p-3">
          <span className="micro-label text-muted-foreground">Where</span>
          <p className="text-[15px] font-medium">{placeLabel(item, houses) || "No place yet"}</p>
          {item.areaName && <p className="text-[12px] text-muted-foreground">{item.areaName}</p>}
        </div>
        {item.roomId != null && item.pos && <ItemRoomPreview roomId={item.roomId} itemId={item.id} />}
        {(lens === "lab" || role(item)) && inLab(item) && (
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-white p-3">
            <span className="micro-label text-muted-foreground">Device</span>
            <LabFields key={item.id} item={item} />
            {holdsData(item) && (
              <>
                <span className="micro-label mt-1 text-muted-foreground">Backup</span>
                <BackupPicker item={item} />
              </>
            )}
          </div>
        )}
        {holdsData(item) && (item.decision === "sell" || item.decision === "donate" || item.decision === "toss") && <SafetyChecklist item={item} />}
        <span className="micro-label text-muted-foreground">Decision</span>
        <DecisionButtons
          current={item.decision}
          disabled={setDecision.isPending}
          onPick={(d) => setDecision.mutate({ id: item.id, decision: d === item.decision ? null : d })}
        />
        <a href={`/items/${item.id}`} className="flex items-center justify-center gap-1.5 py-2 text-[13px] text-[#3C5D41] underline">
          <ExternalLink className="h-3.5 w-3.5" /> Open in the Workbench
        </a>
      </div>
    </Sheet>
  );
}
