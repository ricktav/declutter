import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { Button } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { ArrowLeft, Loader2, Check, X, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react";
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
  const navigate = useNavigate();
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
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [cutMode, setCutMode] = useState(false);
  const [pendingCut, setPendingCut] = useState<{ xM: number; yM: number; wM: number; dM: number } | null>(null);
  const [cutName, setCutName] = useState("");
  const selectedItem = room.data?.items.find((it) => it.id === selectedId) ?? null;

  const unlinkedLocations = trpc.rooms.unlinkedLocations.useQuery(
    { houseId: room.data?.houseId ?? 0 },
    { enabled: room.data?.houseId != null && pendingCut != null },
  );
  const cutFromRoom = trpc.rooms.cutFromRoom.useMutation({
    onSuccess: ({ id: newRoomId }) => {
      setPendingCut(null);
      setCutMode(false);
      setCutName("");
      utils.rooms.get.invalidate({ id });
      navigate(`/rooms/${newRoomId}`);
    },
  });
  const removeRoom = trpc.rooms.remove.useMutation({
    onSuccess: () => {
      if (room.data?.parentRoomId != null) navigate(`/rooms/${room.data.parentRoomId}`);
      else navigate("/rooms");
    },
  });

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
            {room.data.widthM}×{room.data.depthM} m
            {room.data.wallHeightM != null ? ` · wall height ${room.data.wallHeightM} m` : ""} · source: {room.data.source}
            {room.data.scanDate ? ` · scanned ${new Date(room.data.scanDate).toLocaleDateString()}` : ""}
          </p>

          <div className="mt-6 flex gap-6 items-start">
            <div className="flex-1 min-w-0 max-w-2xl">
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <Button
                  size="sm"
                  variant={cutMode ? "default" : "outline"}
                  className="h-7 text-[12px]"
                  onClick={() => {
                    setCutMode((v) => !v);
                    setPendingCut(null);
                    setSelectedId(null);
                  }}
                >
                  <Scissors className="h-3.5 w-3.5 mr-1" /> {cutMode ? "Cutting…" : "Cut out room"}
                </Button>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title="Rotate view -90°"
                    onClick={() => setRotation((r) => ((r + 270) % 360) as typeof rotation)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title="Rotate view +90°"
                    onClick={() => setRotation((r) => ((r + 90) % 360) as typeof rotation)}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                  <ConfirmDelete
                    trigger={
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-destructive hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    }
                    title={`Delete "${room.data.name}"?`}
                    description={
                      room.data.parentRoomId != null
                        ? "Its placed items move back to the parent floor plan, re-positioned in that plan's frame. The parent's own geometry is untouched."
                        : "This is the only floor plan for this space - there's no parent to fall back on. Its items will be unlinked from any room geometry (not deleted, just un-placed). This cannot be undone."
                    }
                    confirmText={room.data.parentRoomId == null ? room.data.name : undefined}
                    confirmLabel="Delete room"
                    pending={removeRoom.isPending}
                    onConfirm={() => removeRoom.mutate({ id })}
                  />
                </div>
              </div>
              {cutMode && (
                <p className="mb-1.5 text-[11px] text-amber-700">
                  Drag a rectangle over the area to cut into its own room.
                </p>
              )}
              <RoomPlan2D
                widthM={room.data.widthM ?? 0}
                depthM={room.data.depthM ?? 0}
                walls={room.data.walls}
                openings={room.data.openings}
                items={room.data.items.map((it) => ({
                  id: it.id,
                  name: it.name,
                  pos: it.pos,
                  editable: it.ownerRoomId === id,
                }))}
                editable
                selectedId={selectedId}
                onSelect={setSelectedId}
                onPosChange={(itemId, pos: ItemPos) => updatePos.mutate({ id: itemId, pos })}
                rotationDeg={rotation}
                cutMode={cutMode}
                onCutRect={(bounds) => {
                  setPendingCut(bounds);
                  setCutName("");
                }}
              />
              <p className="mt-2 text-[11px] text-muted-foreground">
                Drag to move · drag the blue circle to rotate (shift = free angle) · drag the corner square to resize.
                The ⟲/⟳ buttons above only rotate the view, not the data.
              </p>
              {room.data.items.filter((it) => !it.pos).length > 0 && (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Unplaced: {room.data.items.filter((it) => !it.pos).map((it) => it.name).join(", ")}
                </p>
              )}
            </div>

            <aside className="w-64 shrink-0 rounded-lg border border-border bg-white p-4">
              {pendingCut ? (
                <>
                  <p className="font-medium text-[14px]">Name this room</p>
                  <p className="text-[12px] text-muted-foreground mt-1">
                    {pendingCut.wM.toFixed(2)}×{pendingCut.dM.toFixed(2)} m
                  </p>

                  {unlinkedLocations.data && unlinkedLocations.data.length > 0 && (
                    <select
                      className="mt-3 w-full h-8 rounded-md border border-border bg-white px-2 text-[13px]"
                      value={unlinkedLocations.data.includes(cutName) ? cutName : ""}
                      onChange={(e) => setCutName(e.target.value)}
                    >
                      <option value="" disabled>
                        Pick an existing location…
                      </option>
                      {unlinkedLocations.data.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  )}

                  <input
                    type="text"
                    placeholder="Or type a new name"
                    className="mt-2 w-full h-8 rounded-md border border-border bg-white px-2 text-[13px]"
                    value={cutName}
                    onChange={(e) => setCutName(e.target.value)}
                  />

                  <div className="mt-3 flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={!cutName.trim() || cutFromRoom.isPending}
                      onClick={() => cutFromRoom.mutate({ sourceRoomId: id, name: cutName.trim(), bounds: pendingCut })}
                    >
                      {cutFromRoom.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                      Create room
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => setPendingCut(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : !selectedItem ? (
                <p className="text-[13px] text-muted-foreground">
                  {cutMode ? "Drag a rectangle on the plan to mark the room's area." : "Select an item on the plan to review it."}
                </p>
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
                  {selectedItem.ownerRoomId !== room.data.id && (
                    <Link
                      to={`/rooms/${selectedItem.ownerRoomId}`}
                      className="mt-1 inline-block text-[12px] text-primary hover:underline"
                    >
                      Edit position in {selectedItem.ownerRoomName} →
                    </Link>
                  )}

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
