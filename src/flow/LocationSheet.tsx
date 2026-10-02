import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { DEFAULT_FLOORS } from "@/components/RoomPicker";
import { cn } from "@/lib/utils";
import { useFlow } from "./context";
import { Sheet } from "./ui";
import type { Place } from "./data";

/**
 * Pick a place: tap a room that already has things in it, or name a new one.
 * Used for "You are in" and for "Where is it?" - same list, same taps.
 */
export function LocationSheet({
  title,
  value,
  onPick,
  onClose,
  allowClear = false,
}: {
  title: string;
  value: Place;
  onPick: (p: Place) => void;
  onClose: () => void;
  allowClear?: boolean;
}) {
  const { houses, locations } = useFlow();
  const [houseId, setHouseId] = useState<number | null>(value.houseId ?? houses[0]?.id ?? null);
  const [floor, setFloor] = useState(value.floor);
  const [room, setRoom] = useState("");

  const house = houses.find((h) => h.id === houseId);
  // null = house never customized its floors (generic list); [] = a building with no floors
  const floors = house?.floors ?? DEFAULT_FLOORS;
  const known = useMemo(
    () => locations.filter((l) => l.houseId === houseId).sort((a, b) => b.count - a.count),
    [locations, houseId],
  );

  const pick = (p: Place) => {
    onPick(p);
    onClose();
  };

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {houses.map((h) => (
            <button
              key={h.id}
              onClick={() => setHouseId(h.id)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-[13px]",
                h.id === houseId ? "border-transparent bg-[#282c20] text-[#f4f4ed]" : "border-border bg-white",
              )}
            >
              {h.name}
            </button>
          ))}
        </div>

        {known.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="micro-label text-muted-foreground">Rooms with things</span>
            {known.map((l) => {
              const on = value.houseId === l.houseId && value.room === l.room && (value.floor || "") === (l.floor || "");
              return (
                <button
                  key={`${l.floor}|${l.room}`}
                  onClick={() => pick({ houseId: l.houseId, floor: l.floor ?? "", room: l.room })}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-3 text-left",
                    on ? "border-[#3C5D41] bg-[#3C5D41]/10" : "border-border bg-white",
                  )}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px] font-medium truncate">{l.room}</span>
                    {l.floor && <span className="block text-[12px] text-muted-foreground">{l.floor}</span>}
                  </span>
                  <span className="font-data text-[12px] text-muted-foreground">{l.count}</span>
                  {on && <Check className="h-4 w-4 text-[#3C5D41]" />}
                </button>
              );
            })}
          </div>
        )}

        <form
          className="flex flex-col gap-2 rounded-xl border border-border bg-white p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!room.trim() || houseId == null) return;
            pick({ houseId, floor, room: room.trim() });
          }}
        >
          <span className="micro-label text-muted-foreground">New room</span>
          {floors.length > 0 && (
            <select
              id="flow-new-floor"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              className="rounded-lg border border-input bg-white px-3 py-2.5 text-[15px]"
            >
              <option value="">Floor…</option>
              {floors.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          <input
            id="flow-new-room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="Room name, for example Keuken"
            className="rounded-lg border border-input px-3 py-2.5 text-[15px]"
          />
          <button
            type="submit"
            disabled={!room.trim() || houseId == null}
            className="rounded-lg bg-[#282c20] py-2.5 text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
          >
            Use this room
          </button>
        </form>

        {allowClear && (
          <button onClick={() => pick({ houseId: null, floor: "", room: "" })} className="text-[13px] text-muted-foreground underline">
            No place
          </button>
        )}
      </div>
    </Sheet>
  );
}
