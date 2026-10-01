import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { getLastLocation } from "@/lib/lastLocation";
import { Box, ChevronRight } from "lucide-react";

/** Scanned-room geometry for the current house context - the entry point
 * into the 2D/3D spatial twin, separate from the plain floor/room text
 * label used elsewhere for quick item location. */
export default function RoomsPage() {
  const houseId = getLastLocation().houseId;
  const rooms = trpc.rooms.listByHouse.useQuery({ houseId: houseId ?? 0 }, { enabled: houseId != null });

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Scanned room geometry - floor plans you can place items on, not just a location label.
      </p>

      <div className="mt-5 space-y-2">
        {houseId == null ? (
          <div className="text-sm text-muted-foreground">Pick a house on the Dashboard first.</div>
        ) : rooms.data?.length === 0 ? (
          <div className="text-sm text-muted-foreground">No scanned rooms for this house yet.</div>
        ) : (
          rooms.data?.map((r) => (
            <Link
              key={r.id}
              to={`/rooms/${r.id}`}
              className="flex items-center gap-3 rounded-lg border border-border bg-white px-4 py-3 hover:bg-accent/40 transition-colors"
            >
              <Box className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block font-medium truncate">{r.name}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {r.widthM}×{r.depthM} m · {r.itemCount} item{r.itemCount === 1 ? "" : "s"}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
