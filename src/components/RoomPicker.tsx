import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Check, Plus } from "lucide-react";

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

  // the selected house's own floor list, if it has customized one, else a
  // generic default (see Settings > Houses to edit a house's floors)
  const selectedHouse = houses.data?.find((h) => h.id === value.houseId);
  const FLOORS = selectedHouse?.floors?.length ? selectedHouse.floors : DEFAULT_FLOORS;

  return (
    <div className="grid grid-cols-3 gap-1.5" ref={wrapRef}>
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
      <div className="relative">
        <input
          className="w-full rounded border border-input bg-white px-1.5 py-1 text-[11px]"
          placeholder="room…"
          value={roomText}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setRoomText(e.target.value);
            onChange({ ...value, room: e.target.value });
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setOpen(false);
          }}
        />
        {open && suggestions.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-40 overflow-auto">
            {suggestions.map((r) => (
              <button
                key={r}
                type="button"
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] hover:bg-accent"
                onClick={() => {
                  setRoomText(r);
                  onChange({ ...value, room: r });
                  setOpen(false);
                }}
              >
                <span className="flex-1 truncate">{r}</span>
                {r === value.room && <Check className="h-3 w-3 text-primary" />}
              </button>
            ))}
          </div>
        )}
        {open && roomText.trim() && !suggestions.includes(roomText.trim()) && (
          <div className="absolute z-20 mt-1 w-full flex items-center gap-1.5 rounded-md border border-primary bg-primary/5 px-2 py-1 text-[11px] text-primary">
            <Plus className="h-3 w-3" /> new room “{roomText.trim()}”
          </div>
        )}
      </div>
    </div>
  );
}
