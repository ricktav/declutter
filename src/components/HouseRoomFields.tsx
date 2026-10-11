import { useHouse } from "@/context/house";
import { RoomPicker } from "@/components/RoomPicker";

/**
 * Context-sensitive Place picker: rooms of the header house, or a house
 * select then that house's rooms when All houses is on. lockToSession
 * false always shows the house select (batch assign to any house).
 */
export function HouseRoomFields({
  houseId,
  roomId,
  onHouse,
  onRoom,
  allowNone = true,
  autoFocus = false,
  lockToSession = true,
}: {
  houseId: number | null;
  roomId: number | null;
  onHouse: (id: number | null) => void;
  onRoom: (id: number | null) => void;
  allowNone?: boolean;
  autoFocus?: boolean;
  /** When true (default), hide the house select while the header has a house. */
  lockToSession?: boolean;
}) {
  const { houseId: sessionHouse, houses } = useHouse();
  const locked = lockToSession && sessionHouse != null;
  const effectiveHouse = locked ? sessionHouse : houseId;

  return (
    <div className={locked ? "space-y-1.5" : "flex flex-wrap items-end gap-2"}>
      {!locked && (
        <label className="block min-w-[8rem]">
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
      <label className="block min-w-[10rem] flex-1">
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
