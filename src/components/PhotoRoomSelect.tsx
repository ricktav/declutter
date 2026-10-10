import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { cn } from "@/lib/utils";

/** Compact house-room dropdown to give a Photo a Place. */
export function PhotoRoomSelect({
  houseId,
  onPick,
  disabled,
  className,
}: {
  houseId?: number | null;
  onPick: (roomId: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { houseId: sessionHouse } = useHouse();
  const hid = houseId ?? sessionHouse ?? null;
  const rooms = trpc.rooms.list.useQuery({ houseId: hid }, { enabled: hid != null });
  const list = rooms.data ?? [];

  if (hid == null) {
    return <p className="text-[11px] text-muted-foreground">Pick a house first.</p>;
  }

  return (
    <select
      aria-label="Assign photo to a room"
      disabled={disabled || rooms.isLoading || list.length === 0}
      className={cn(
        "h-7 w-full rounded-md border border-input bg-white px-1.5 text-[11px] text-foreground",
        className,
      )}
      defaultValue=""
      onChange={(e) => {
        const id = Number(e.target.value);
        if (Number.isInteger(id) && id > 0) onPick(id);
        e.currentTarget.value = "";
      }}
    >
      <option value="" disabled>
        {rooms.isLoading ? "Loading rooms…" : list.length ? "Assign room…" : "No rooms"}
      </option>
      {list.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.floor ? ` · ${r.floor}` : ""}
        </option>
      ))}
    </select>
  );
}
