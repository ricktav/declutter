import { useHouse } from "@/context/house";
import { RoomPicker } from "@/components/RoomPicker";

/**
 * Context-sensitive Place picker: rooms of the header house, or a house
 * select then that house's rooms when All houses is on.
 */
export function HouseRoomFields({
  houseId,
  roomId,
  onHouse,
  onRoom,
  allowNone = true,
  autoFocus = false,
}: {
  houseId: number | null;
  roomId: number | null;
  onHouse: (id: number | null) => void;
  onRoom: (id: number | null) => void;
  allowNone?: boolean;
  autoFocus?: boolean;
}) {
  const { houseId: sessionHouse, houses } = useHouse();
  const locked = sessionHouse != null;
  const effectiveHouse = locked ? sessionHouse : houseId;

  return (
    <div className="space-y-1.5">
      {!locked && (
        <label className="block">
          <span className="micro-label text-muted-foreground">House</span>
          <select
            className="mt-0.5 w-full rounded border border-input bg-white px-2 py-1.5 text-[13px]"
            value={houseId ?? ""}
            aria-label="House"
            onChange={(e) => {
              const next = e.target.value ? Number(e.target.value) : null;
              onHouse(next);
              onRoom(null);
            }}
          >
            <option value="">Pick a house…</option>
            {houses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        {!locked && <span className="micro-label text-muted-foreground">Place</span>}
        <div className={locked ? "" : "mt-0.5"}>
          <RoomPicker
            value={roomId}
            onChange={onRoom}
            houseId={effectiveHouse ?? undefined}
            allowNone={allowNone}
            autoFocus={autoFocus && locked}
          />
        </div>
      </label>
    </div>
  );
}
