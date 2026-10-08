// src/components/RoomPicker.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { DUTCH_FLOOR_DEFAULTS, sortFloorNames } from "@/lib/floors";
import { cn } from "@/lib/utils";

// Flow contract: English names used for sort rank / fallback there. Workbench
// suggestions use DUTCH_FLOOR_DEFAULTS when a house has no floors yet.
// eslint-disable-next-line react-refresh/only-export-components
export const DEFAULT_FLOORS = ["basement", "ground", "1", "2", "3", "attic"];

/**
 * Pick a room in the current house. Floor is shown on each room, never
 * asked for separately; only the "create room …" row offers a floor.
 */
export function RoomPicker({
  value,
  onChange,
  houseId: houseIdProp,
  allowCreate = true,
  allowNone = false,
  autoFocus = false,
}: {
  value: number | null;
  onChange: (roomId: number | null) => void;
  houseId?: number;
  allowCreate?: boolean;
  allowNone?: boolean;
  autoFocus?: boolean;
}) {
  const { houseId: ctxHouseId } = useHouse();
  const houseId = houseIdProp ?? ctxHouseId;
  const utils = trpc.useUtils();
  const rooms = trpc.rooms.list.useQuery({ houseId: houseId ?? null }, { enabled: houseId != null });
  const ensure = trpc.rooms.ensure.useMutation({
    onSuccess: (r) => {
      utils.rooms.list.invalidate();
      onChange(r.id);
      setOpen(false);
    },
  });

  const selected = rooms.data?.find((r) => r.id === value) ?? null;
  const [text, setText] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [newFloor, setNewFloor] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const [syncedName, setSyncedName] = useState(selected?.name ?? "");
  if ((selected?.name ?? "") !== syncedName) {
    setSyncedName(selected?.name ?? "");
    setText(selected?.name ?? "");
  }
  // close path: commit typed text if it names a room, clear if allowed,
  // otherwise snap the text back to the saved room
  const commitText = () => {
    const t = text.trim().toLowerCase();
    const hit = t ? (rooms.data ?? []).find((r) => r.name.toLowerCase() === t) : undefined;
    if (hit) onChange(hit.id);
    else if (!t && allowNone) onChange(null);
    else setText(selected?.name ?? "");
    setOpen(false);
  };
  const commitRef = useRef(commitText);
  const insideRef = useRef(false);
  const openRef = useRef(open);
  useEffect(() => {
    commitRef.current = commitText;
    openRef.current = open;
  });
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (openRef.current && wrapRef.current && !wrapRef.current.contains(e.target as Node)) commitRef.current();
    };
    const onUp = () => { insideRef.current = false; };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const q = text.trim().toLowerCase();
  const matches = useMemo(
    () => (rooms.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 12),
    [rooms.data, q],
  );
  const exact = (rooms.data ?? []).find((r) => r.name.toLowerCase() === q);
  const showCreate = allowCreate && q.length > 0 && !exact;
  const knownFloors = useMemo(() => {
    const f = [...new Set((rooms.data ?? []).map((r) => r.floor).filter((x): x is string => !!x))];
    return f.length ? sortFloorNames(f) : DUTCH_FLOOR_DEFAULTS;
  }, [rooms.data]);
  const rowCount = matches.length + (showCreate ? 1 : 0);
  const [hlKey, setHlKey] = useState(`${q}|${rowCount}`);
  if (hlKey !== `${q}|${rowCount}`) {
    setHlKey(`${q}|${rowCount}`);
    setHighlight(0);
  }

  const pick = (id: number) => {
    onChange(id);
    setOpen(false);
  };
  const create = () => {
    if (houseId == null || !text.trim()) return;
    ensure.mutate({ houseId, name: text.trim(), floor: newFloor || null });
  };
  const selectAt = (i: number) => {
    if (i < matches.length) pick(matches[i].id);
    else if (showCreate) create();
  };

  if (houseId == null) {
    return <div className="text-[12px] text-muted-foreground">Pick a house first.</div>;
  }

  return (
    <div className="relative" ref={wrapRef} onMouseDown={() => { insideRef.current = true; }}>
      <input
        id="room-picker"
        autoFocus={autoFocus}
        className="w-full rounded border border-input bg-white px-2 py-1 pr-6 text-[12px]"
        placeholder="room…"
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (open && !insideRef.current) commitText(); }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (e.target.value.trim() === "" && allowNone) onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { commitText(); return; }
          if (!open || rowCount === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % rowCount); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + rowCount) % rowCount); }
          else if (e.key === "Enter") { e.preventDefault(); selectAt(highlight); }
        }}
      />
      {!open && selected && text.trim().toLowerCase() === selected.name.toLowerCase() && <Check className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-emerald-600" />}
      {open && rowCount > 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-56 overflow-auto">
          {matches.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className={cn("flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]", i === highlight ? "bg-accent" : "hover:bg-accent")}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(r.id); }}
            >
              <span className="flex-1 truncate">{r.name}</span>
              {r.floor && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{r.floor}</span>}
              {r.hasGeometry && <span className="text-[10px] text-muted-foreground">plan</span>}
              {r.id === value && <Check className="h-3 w-3 text-primary" />}
            </button>
          ))}
          {showCreate && (
            <div
              className={cn("flex items-center gap-2 border-t border-border px-2 py-1 text-[11px]", highlight === matches.length ? "bg-primary/10" : "bg-primary/5")}
              onMouseEnter={() => setHighlight(matches.length)}
            >
              <button type="button" className="flex items-center gap-1 text-primary" onMouseDown={(e) => { e.preventDefault(); create(); }}>
                <Plus className="h-3 w-3" /> create "{text.trim()}"
              </button>
              <select
                id="room-picker-new-floor"
                aria-label="Floor of the new room"
                className="ml-auto rounded border border-input bg-white px-1 py-0.5 text-[11px]"
                value={newFloor}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setNewFloor(e.target.value)}
              >
                <option value="">no floor</option>
                {knownFloors.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      {ensure.isError && <div className="mt-1 text-[11px] text-destructive">{ensure.error.message}</div>}
    </div>
  );
}
