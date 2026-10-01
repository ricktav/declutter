import { useState } from "react";
import { useParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, Check, X } from "lucide-react";
import type { ItemPos } from "@db/schema";

/**
 * 2D floor plan for a scanned room. Select/drag/rotate/resize placed items
 * (3D twin lands in a later phase - see docs/spatial-twin-full-rewrite-
 * estimate.md for the plan this follows: porting lidarventory's vanilla SVG
 * engine, not rewriting it).
 */
export default function RoomPlanPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const id = Number(roomId);
  const room = trpc.rooms.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const utils = trpc.useUtils();
  const updatePos = trpc.items.update.useMutation({
    onSuccess: () => utils.rooms.get.invalidate({ id }),
  });
  const setVerification = trpc.items.setVerification.useMutation({
    onSuccess: () => utils.rooms.get.invalidate({ id }),
  });
  const removeItem = trpc.items.remove.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      utils.rooms.get.invalidate({ id });
    },
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedItem = room.data?.items.find((it) => it.id === selectedId) ?? null;

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

          <div className="mt-6 flex gap-6 items-start">
            <div className="flex-1 min-w-0 max-w-2xl">
              <RoomPlan2D
                widthM={room.data.widthM ?? 0}
                depthM={room.data.depthM ?? 0}
                walls={room.data.walls}
                openings={room.data.openings}
                items={room.data.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos }))}
                editable
                selectedId={selectedId}
                onSelect={setSelectedId}
                onPosChange={(itemId, pos: ItemPos) => updatePos.mutate({ id: itemId, pos })}
              />
              <p className="mt-2 text-[11px] text-muted-foreground">
                Drag to move · drag the blue circle to rotate (shift = free angle) · drag the corner square to resize.
              </p>
              {room.data.items.filter((it) => !it.pos).length > 0 && (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Unplaced: {room.data.items.filter((it) => !it.pos).map((it) => it.name).join(", ")}
                </p>
              )}
            </div>

            <aside className="w-64 shrink-0 rounded-lg border border-border bg-white p-4">
              {!selectedItem ? (
                <p className="text-[13px] text-muted-foreground">Select an item on the plan to review it.</p>
              ) : (
                <>
                  <Link to={`/items/${selectedItem.id}`} className="font-medium text-[14px] hover:underline">
                    {selectedItem.name}
                  </Link>
                  <p className="text-[12px] text-muted-foreground mt-1">
                    {selectedItem.pos
                      ? `${selectedItem.pos.wM}×${selectedItem.pos.dM} m${selectedItem.pos.baseM ? ` · on top of something (${selectedItem.pos.baseM} m)` : ""}`
                      : "Not placed on the plan"}
                  </p>

                  {selectedItem.verificationStatus === "detected" ? (
                    <div className="mt-3 flex gap-1.5">
                      <Button
                        size="sm"
                        className="h-7 text-[12px] bg-amber-700 hover:bg-amber-800"
                        onClick={() => setVerification.mutate({ id: selectedItem.id, verificationStatus: "confirmed" })}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" /> Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[12px]"
                        onClick={() => removeItem.mutate({ id: selectedItem.id })}
                      >
                        <X className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 inline-flex items-center gap-1 text-[12px] text-emerald-700">
                      <Check className="h-3.5 w-3.5" /> Confirmed
                    </p>
                  )}
                </>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
