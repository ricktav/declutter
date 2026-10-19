// Annotate's "Place a Thing" side panel: the room's Things (rows from
// usePlaceThings), a filter, a flag star per Thing pinned here, and "Search
// all Things". Pick one, tap the Photo; Annotate does the tap.
import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, Search, Star, X } from "lucide-react";
import { ItemPicker } from "@/components/ItemPicker";
import { cn } from "@/lib/utils";
import type { PlacePin, PlaceRow, PlaceState } from "@/lib/placeThings";

const STATE_LABEL: Record<PlaceState, string> = {
  here: "pinned here",
  elsewhere: "pinned elsewhere",
  none: "not pinned",
};

export function PlaceThingPanel({
  hasRoom,
  rows,
  loading,
  selected,
  onSelect,
  onToggleFlag,
  hint,
}: {
  hasRoom: boolean;
  rows: PlaceRow[];
  loading: boolean;
  selected: { id: number; name: string } | null;
  onSelect: (thing: { id: number; name: string } | null) => void;
  onToggleFlag: (pin: PlacePin) => void;
  hint: string | null;
}) {
  const [q, setQ] = useState("");
  const [searchAllOpen, setSearchAllOpen] = useState(false);
  // without a room the search is all there is
  const searchAll = searchAllOpen || !hasRoom;
  const needle = q.trim().toLowerCase();
  const visible = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  const selectedRow = selected ? (rows.find((r) => r.id === selected.id) ?? null) : null;

  return (
    <div className="rounded-lg border border-primary bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="micro-label text-primary">Place a Thing</div>
        <span className="text-[11px] text-muted-foreground">pick a Thing, then tap the Photo · Esc clears</span>
      </div>

      {selected && (
        <div className="space-y-1 rounded bg-accent px-2 py-1 text-[12px]" data-place-selected={selected.id}>
          <div className="flex items-center gap-1">
            Placing: <b className="truncate">{selected.name}</b>
            <button className="ml-auto" title="Clear (Esc)" onClick={() => onSelect(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
          {selectedRow?.state === "here" && (
            <div className="text-muted-foreground">Already on this Photo: a tap moves its pin and keeps its frame.</div>
          )}
          {selectedRow?.state === "elsewhere" && (
            <div className="flex items-start gap-1 text-amber-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Already pinned elsewhere — make sure this is the same physical object, not a similar one that needs
                its own Thing.
              </span>
            </div>
          )}
        </div>
      )}
      {hint && <div className="text-[12px] text-amber-700">{hint}</div>}

      {hasRoom && (
        <>
          <div className="flex items-center gap-1.5 rounded-md border border-input bg-white px-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              className="flex-1 bg-transparent py-1.5 text-[13px] outline-none"
              placeholder="Filter this room's Things…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {loading && <div className="text-[12px] text-muted-foreground">Loading Things…</div>}
          {!loading && rows.length === 0 && (
            <div className="text-[12px] text-muted-foreground">No Things in this room yet.</div>
          )}
          <div className="max-h-[22rem] space-y-0.5 overflow-y-auto">
            {visible.map((r) => {
              const isSel = selected?.id === r.id;
              return (
                <div
                  key={r.id}
                  data-place-row={r.id}
                  data-place-state={r.state}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[13px]",
                    isSel ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-accent",
                  )}
                  onClick={() => onSelect(isSel ? null : { id: r.id, name: r.name })}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {r.name}
                    {r.roomName && <span className="ml-1 text-[11px] text-muted-foreground">· {r.roomName}</span>}
                  </span>
                  {r.chip && (
                    <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-data text-[10px] text-muted-foreground">
                      {r.chip}
                    </span>
                  )}
                  <span
                    className={cn(
                      "shrink-0 text-[10px]",
                      r.state === "here" ? "text-emerald-700" : r.state === "elsewhere" ? "text-amber-700" : "text-muted-foreground",
                    )}
                  >
                    {STATE_LABEL[r.state]}
                  </span>
                  <button
                    className={cn(
                      "shrink-0 disabled:opacity-30",
                      r.pinHere?.flagged ? "text-amber-500" : "text-muted-foreground hover:text-amber-500",
                    )}
                    disabled={!r.pinHere}
                    title={
                      r.pinHere
                        ? r.pinHere.flagged
                          ? "Flagged on this Photo — click to clear"
                          : "Flag on this Photo"
                        : "Pin it on this Photo first"
                    }
                    aria-pressed={r.pinHere?.flagged ?? false}
                    data-place-flag={r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.pinHere) onToggleFlag(r.pinHere);
                    }}
                  >
                    <Star className={cn("h-3.5 w-3.5", r.pinHere?.flagged && "fill-current")} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {searchAll ? (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">Search all Things (every house)</div>
          <ItemPicker
            placeholder="Search all Things…"
            houseId={null}
            onSelect={(item) => onSelect({ id: item.id, name: item.name })}
          />
        </div>
      ) : (
        <button className="text-[12px] text-primary hover:underline" onClick={() => setSearchAllOpen(true)}>
          Search all Things…
        </button>
      )}
      {selected && !selectedRow && (
        <div className="text-[11px] text-muted-foreground">
          Not in this room&apos;s list. <Link className="text-primary hover:underline" to={`/items/${selected.id}`}>Open Thing</Link>
        </div>
      )}
    </div>
  );
}
