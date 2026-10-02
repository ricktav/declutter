import { lazy, Suspense, useState } from "react";
import { Link, useInRouterContext } from "react-router";
import { Box } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
const RoomPlan3D = lazy(() => import("@/components/RoomPlan3D").then((m) => ({ default: m.RoomPlan3D })));

/**
 * Compact, read-only 2D/3D room-plan preview for an item's detail page -
 * shows where the item sits among its room's other items, highlighted.
 * Renders nothing when the item has no room placement yet.
 */
export function ItemRoomPreview({ roomId, itemId }: { roomId: number; itemId: number }) {
  const room = trpc.rooms.get.useQuery({ id: roomId });
  // the Flow front end has no router - there the room name is a plain link into the Workbench
  const inRouter = useInRouterContext();
  const [view, setView] = useState<"2d" | "3d">("2d");
  // three.js (and its WebGL context) is only loaded once the 3D tab is opened
  const [opened3d, setOpened3d] = useState(false);

  if (!room.data) return null;
  const planItems = room.data.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos }));

  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        {inRouter ? (
          <Link to={`/rooms/${roomId}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.data.name}
          </Link>
        ) : (
          <a href={`/rooms/${roomId}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.data.name}
          </a>
        )}
        <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
          <button
            type="button"
            onClick={() => setView("2d")}
            className={`px-2 py-0.5 rounded text-[10px] font-medium ${view === "2d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
          >
            2D
          </button>
          <button
            type="button"
            onClick={() => { setOpened3d(true); setView("3d"); }}
            className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5 ${view === "3d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
          >
            <Box className="h-2.5 w-2.5" /> 3D
          </button>
        </div>
      </div>
      <div className="max-w-[220px] mx-auto">
        {/* once opened, both views stay mounted so switching tabs doesn't
            tear down the 3D view's WebGL context */}
        <div hidden={view !== "2d"}>
          <RoomPlan2D
            widthM={room.data.widthM ?? 0}
            depthM={room.data.depthM ?? 0}
            walls={room.data.walls}
            openings={room.data.openings}
            items={planItems}
            selectedId={itemId}
          />
        </div>
        <div hidden={view !== "3d"}>
          {opened3d && (
          <Suspense fallback={null}>
          <RoomPlan3D
            widthM={room.data.widthM ?? 0}
            depthM={room.data.depthM ?? 0}
            wallHeightM={room.data.wallHeightM}
            walls={room.data.walls}
            items={planItems}
            selectedId={itemId}
            active={view === "3d"}
          />
          </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
