import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { DEFAULT_FLOORS } from "@/components/RoomPicker";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { useFlow } from "./context";
import { ErrorLine, Sheet } from "./ui";
import type { Place } from "./data";

/**
 * Pick a place: tap a room of the current house, or name a new one.
 * Used for "You are in" and for "Where is it?" - same list, same taps.
 * The house itself is changed from the header switcher.
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
  const { locations } = useFlow();
  const utils = trpc.useUtils();
  const [floor, setFloor] = useState("");
  const [room, setRoom] = useState("");
  const [error, setError] = useState<string | null>(null);

  const known = useMemo(() => [...locations].sort((a, b) => b.itemCount - a.itemCount), [locations]);
  const floors = useMemo(() => {
    const distinct = [...new Set(locations.map((l) => l.floor).filter((f): f is string => !!f))];
    return distinct.length > 0 ? distinct : DEFAULT_FLOORS;
  }, [locations]);

  const pick = (p: Place) => {
    onPick(p);
    onClose();
  };

  const ensure = trpc.rooms.ensure.useMutation({
    onSuccess: (res) => {
      utils.rooms.list.invalidate();
      pick({ roomId: res.id });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {known.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="micro-label text-muted-foreground">Rooms</span>
            {known.map((l) => {
              const on = value.roomId === l.id;
              return (
                <button
                  key={l.id}
                  onClick={() => pick({ roomId: l.id })}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border px-3 py-3 text-left",
                    on ? "border-[#3C5D41] bg-[#3C5D41]/10" : "border-border bg-white",
                  )}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px] font-medium truncate">{l.name}</span>
                    {l.floor && <span className="block text-[12px] text-muted-foreground">{l.floor}</span>}
                  </span>
                  <span className="font-data text-[12px] text-muted-foreground">{l.itemCount}</span>
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
            if (!room.trim() || ensure.isPending) return;
            setError(null);
            ensure.mutate({ name: room.trim(), floor: floor || undefined });
          }}
        >
          <span className="micro-label text-muted-foreground">New room</span>
          <input
            id="flow-new-room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="Room name, for example Keuken"
            className="rounded-lg border border-input px-3 py-2.5 text-[15px]"
          />
          <select
            id="flow-new-floor"
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            className="rounded-lg border border-input bg-white px-3 py-2.5 text-[15px]"
          >
            <option value="">Floor (optional)</option>
            {floors.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <ErrorLine message={error} />
          <button
            type="submit"
            disabled={!room.trim() || ensure.isPending}
            className="rounded-lg bg-[#282c20] py-2.5 text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
          >
            Use this room
          </button>
        </form>

        {allowClear && (
          <button onClick={() => pick({ roomId: null })} className="text-[13px] text-muted-foreground underline">
            No place
          </button>
        )}
      </div>
    </Sheet>
  );
}
