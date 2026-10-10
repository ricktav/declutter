import { useMemo, useState } from "react";

type RoomHit = { id: number; name: string; floor: string | null };

/** Type a new room name, or pick an existing room in the same house to merge. */
export function RoomNameField({
  value,
  onChange,
  rooms,
  currentId,
  onPickExisting,
}: {
  value: string;
  onChange: (v: string) => void;
  rooms: RoomHit[];
  currentId: number;
  onPickExisting: (room: RoomHit) => void;
}) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    return rooms.filter((r) => r.id !== currentId && r.name.toLowerCase().includes(q)).slice(0, 8);
  }, [rooms, currentId, q]);

  return (
    <div className="relative">
      <input
        className="w-full rounded border border-input px-2 py-1.5 text-[13px]"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-48 overflow-auto rounded-md border border-border bg-white shadow-lg">
          {matches.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-[13px] hover:bg-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r.name);
                  onPickExisting(r);
                  setOpen(false);
                }}
              >
                <span className="font-medium">{r.name}</span>
                {r.floor && <span className="ml-1.5 text-[11px] text-muted-foreground">{r.floor}</span>}
                <span className="ml-2 text-[11px] text-muted-foreground">merge</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
