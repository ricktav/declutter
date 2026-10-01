import { useParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { ArrowLeft, Loader2 } from "lucide-react";

/**
 * 2D floor plan for a scanned room - phase 1 skeleton. Renders geometry
 * read-only for now; drag/rotate/resize and the 3D twin land in later
 * phases (see docs/spatial-twin-full-rewrite-estimate.md for the plan this
 * follows - porting lidarventory's vanilla SVG engine, not rewriting it).
 */
export default function RoomPlanPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const id = Number(roomId);
  const room = trpc.rooms.get.useQuery({ id }, { enabled: Number.isFinite(id) });

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link to="/rooms" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground w-fit">
        <ArrowLeft className="h-3.5 w-3.5" /> Rooms
      </Link>

      {room.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !room.data ? (
        <div className="mt-6 text-sm text-muted-foreground">Room not found.</div>
      ) : (
        <>
          <h1 className="text-2xl font-semibold tracking-tight mt-2">{room.data.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {room.data.widthM}×{room.data.depthM} m · wall height {room.data.wallHeightM} m · source: {room.data.source}
            {room.data.scanDate ? ` · scanned ${new Date(room.data.scanDate).toLocaleDateString()}` : ""}
          </p>

          <div className="mt-6 max-w-2xl">
            <RoomPlan2D
              widthM={room.data.widthM ?? 0}
              depthM={room.data.depthM ?? 0}
              walls={room.data.walls}
              openings={room.data.openings}
              items={room.data.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos }))}
            />
          </div>
          {room.data.items.filter((it) => !it.pos).length > 0 && (
            <p className="mt-3 text-[12px] text-muted-foreground">
              Unplaced: {room.data.items.filter((it) => !it.pos).map((it) => it.name).join(", ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
