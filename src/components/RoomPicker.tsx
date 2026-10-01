import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export type RoomValue = { houseId: number | null; floor: string; room: string };

export const DEFAULT_FLOORS = ["basement", "ground", "1", "2", "3", "attic"];

/**
 * House → floor → room picker. Rooms are discovered from existing items,
 * so they grow as you file things; typing a new room offers to create it.
 */
export function RoomPicker({
  value,
  onChange,
}: {
  value: RoomValue;
  onChange: (v: RoomValue) => void;
}) {
  const houses = trpc.houses.list.useQuery();
  const [roomText, setRoomText] = useState(value.room);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setRoomText(value.room), [value.room]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // discover rooms per house+floor from items
  const roomOptions = trpc.houses.rooms.useQuery(
    { houseId: value.houseId ?? 0 },
    { enabled: value.houseId != null },
  );
  const suggestions = useMemo(() => {
    const opts: { floor: string | null; room: string }[] = roomOptions.data ?? [];
    const filtered = value.floor
      ? opts.filter((o) => o.floor === value.floor)
      : opts;
    const names = [...new Set(filtered.map((o) => o.room))];
    const q = roomText.trim().toLowerCase();
    return (q ? names.filter((n) => n.toLowerCase().includes(q)) : names).slice(0, 8);
  }, [roomOptions.data, value.floor, roomText]);

  const showCreateRow = roomText.trim().length > 0 && !suggestions.includes(roomText.trim());
  const rowCount = suggestions.length + (showCreateRow ? 1 : 0);

  useEffect(() => setHighlight(0), [roomText, suggestions.length]);

  const commitRoom = (r: string) => {
    setRoomText(r);
    onChange({ ...value, room: r });
    setOpen(false);
  };

  const selectAt = (i: number) => {
    if (i < suggestions.length) commitRoom(suggestions[i]);
    else if (showCreateRow) commitRoom(roomText.trim());
  };

  // the selected house's own floor list: null means "not customized yet"
  // (generic default list applies), a non-empty array is a custom list, and
  // an explicit empty array means "this building has no floors" - hide the
  // field entirely rather than make every item pick a meaningless floor
  const selectedHouse = houses.data?.find((h) => h.id === value.houseId);
  const houseFloors = selectedHouse?.floors;
  const hasNoFloors = Array.isArray(houseFloors) && houseFloors.length === 0;
  const FLOORS = houseFloors && houseFloors.length > 0 ? houseFloors : DEFAULT_FLOORS;

  useEffect(() => {
    if (hasNoFloors && value.floor !== "") onChange({ ...value, floor: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNoFloors]);

  return (
    <div className={hasNoFloors ? "grid grid-cols-2 gap-1.5" : "grid grid-cols-3 gap-1.5"} ref={wrapRef}>
      <select
        className="rounded border border-input bg-white px-1.5 py-1 text-[11px]"
        value={value.houseId ?? ""}
        onChange={(e) =>
          onChange({ ...value, houseId: e.target.value ? Number(e.target.value) : null })
        }
      >
        <option value="">house…</option>
        {(houses.data ?? []).map((h) => (
          <option key={h.id} value={h.id}>{h.name}</option>
        ))}
      </select>
      {!hasNoFloors && (
        <select
          className="rounded border border-input bg-white px-1.5 py-1 text-[11px]"
          value={value.floor}
          onChange={(e) => onChange({ ...value, floor: e.target.value })}
        >
          <option value="">floor…</option>
          {FLOORS.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      )}
      <div className="relative">
        <input
          className="w-full rounded border border-input bg-white px-1.5 py-1 pr-5 text-[11px]"
          placeholder="room…"
          value={roomText}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setRoomText(e.target.value);
            onChange({ ...value, room: e.target.value });
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!open || rowCount === 0) {
              if (e.key === "Escape") setOpen(false);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % rowCount);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + rowCount) % rowCount);
            } else if (e.key === "Enter") {
              e.preventDefault();
              selectAt(highlight);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {/* persistent confirmation that a room is actually set, once the
            dropdown isn't covering it up - typing alone gives no feedback
            that anything "took" */}
        {!open && roomText.trim() && (
          <Check className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 text-emerald-600" />
        )}
        {open && rowCount > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-40 overflow-auto">
            {suggestions.map((r, i) => (
              <button
                key={r}
                type="button"
                className={cn(
                  "flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px]",
                  i === highlight ? "bg-accent" : "hover:bg-accent",
                )}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectAt(i);
                }}
              >
                <span className="flex-1 truncate">{r}</span>
                {r === value.room && <Check className="h-3 w-3 text-primary" />}
              </button>
            ))}
            {showCreateRow && (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-1.5 border-t border-border px-2 py-1 text-left text-[11px] text-primary",
                  highlight === suggestions.length ? "bg-primary/10" : "bg-primary/5 hover:bg-primary/10",
                )}
                onMouseEnter={() => setHighlight(suggestions.length)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectAt(suggestions.length);
                }}
              >
                <Plus className="h-3 w-3 shrink-0" />
                <span className="truncate">create room "{roomText.trim()}" (Enter)</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
