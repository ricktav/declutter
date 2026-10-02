import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { RoomPlan3D } from "@/components/RoomPlan3D";
import { Button } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { ItemPicker } from "@/components/ItemPicker";
import { applyStacking } from "@/lib/roomStacking";
import { ArrowLeft, Loader2, Check, X, RotateCcw, RotateCw, Scissors, Trash2, MapPin, Box, Plus } from "lucide-react";
import type { ItemPos } from "@db/schema";

/**
 * Floor plan for a scanned room - 2D (drag/rotate/resize/stacking/cut) and
 * 3D (orbit, same pinning) views of the same underlying room/item data, so
 * pinning a new item or confirming one works the same regardless of which
 * tab is open.
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
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [cutMode, setCutMode] = useState(false);
  const [pendingCut, setPendingCut] = useState<{ xM: number; yM: number; wM: number; dM: number } | null>(null);
  const [cutName, setCutName] = useState("");
  const [pinMode, setPinMode] = useState(false);
  const [pendingPin, setPendingPin] = useState<{ xM: number; yM: number } | null>(null);
  const [pinName, setPinName] = useState("");
  const [pinAreaId, setPinAreaId] = useState<number | null>(null);
  const selectedItem = room.data?.items.find((it) => it.id === selectedId) ?? null;
  const planItems =
    room.data?.items.map((it) => ({
      id: it.id,
      name: it.name,
      pos: it.pos,
      editable: it.ownerRoomId === id,
    })) ?? [];
  const areasList = trpc.areas.list.useQuery(undefined, { enabled: pendingPin != null });
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const selectedDetail = trpc.items.get.useQuery({ id: selectedId ?? -1 }, { enabled: selectedId != null });
  const setParent = trpc.items.setParent.useMutation();

  /** Put an existing floor item inside the currently selected one (cabinet,
   * drawer, table) - it stops being its own box on the plan; the host is
   * now the only place that says where it physically is. */
  const putInside = async (childId: number) => {
    if (selectedId == null) return;
    const res = await setParent.mutateAsync({ id: childId, parentId: selectedId });
    if (!res.ok) {
      setAttachError(res.error);
      return;
    }
    setAttaching(false);
    setAttachError(null);
    await updatePos.mutateAsync({ id: childId, pos: null });
    await utils.items.get.invalidate({ id: selectedId });
    utils.rooms.get.invalidate({ id });
  };

  const takeOut = async (childId: number) => {
    await setParent.mutateAsync({ id: childId, parentId: null });
    if (selectedId != null) utils.items.get.invalidate({ id: selectedId });
  };

  const selectItem = (itemId: number) => {
    setSelectedId(itemId);
    setAttaching(false);
    setAttachError(null);
  };

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
  const createItem = trpc.items.create.useMutation();
  const [pinning, setPinning] = useState(false);

  /** Shared by both the 2D plan and the 3D twin - pinning a point creates a
   * real item at that footprint, status "confirmed" (a human just placed it
   * by hand, there's nothing to verify), default 0.5x0.5m (resize after). */
  const confirmPin = async () => {
    if (!pendingPin || !pinName.trim() || pinAreaId == null || !room.data) return;
    setPinning(true);
    try {
      const { id: newItemId } = await createItem.mutateAsync({
        areaId: pinAreaId,
        name: pinName.trim(),
        houseId: room.data.houseId,
        roomId: id,
        room: room.data.name,
      });
      const basePos = { xM: pendingPin.xM, yM: pendingPin.yM, wM: 0.5, dM: 0.5, rotDeg: 0 };
      await updatePos.mutateAsync({
        id: newItemId,
        // a new pin lands on whatever's already under it (a table, a desk)
        // the same way dragging an existing item does - stacked, not floating
        // at floor level just because it was just created
        pos: applyStacking(-1, basePos, planItems),
      });
      setPendingPin(null);
      setPinName("");
      setPinMode(false);
      setSelectedId(newItemId);
    } finally {
      setPinning(false);
    }
  };

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
              <div className="flex items-center gap-1 mb-2 rounded-md bg-muted/50 p-0.5 w-fit">
                <button
                  type="button"
                  onClick={() => setView("2d")}
                  className={`px-3 py-1 rounded text-[12px] font-medium ${view === "2d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
                >
                  2D Plan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setView("3d");
                    setCutMode(false);
                    setPendingCut(null);
                  }}
                  className={`px-3 py-1 rounded text-[12px] font-medium flex items-center gap-1 ${view === "3d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
                >
                  <Box className="h-3 w-3" /> 3D Twin
                </button>
              </div>
              <div className="flex items-center justify-between gap-1 mb-1.5">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={pinMode ? "default" : "outline"}
                    className="h-7 text-[12px]"
                    onClick={() => {
                      setPinMode((v) => !v);
                      setPendingPin(null);
                      setCutMode(false);
                      setPendingCut(null);
                      setSelectedId(null);
                    }}
                  >
                    <MapPin className="h-3.5 w-3.5 mr-1" /> {pinMode ? "Pinning…" : "Pin new item"}
                  </Button>
                  {view === "2d" && (
                    <Button
                      size="sm"
                      variant={cutMode ? "default" : "outline"}
                      className="h-7 text-[12px]"
                      onClick={() => {
                        setCutMode((v) => !v);
                        setPendingCut(null);
                        setPinMode(false);
                        setPendingPin(null);
                        setSelectedId(null);
                      }}
                    >
                      <Scissors className="h-3.5 w-3.5 mr-1" /> {cutMode ? "Cutting…" : "Cut out room"}
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {view === "2d" && (
                    <>
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
                    </>
                  )}
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
              {pinMode && (
                <p className="mb-1.5 text-[11px] text-amber-700">Click anywhere on the floor to pin a new item there.</p>
              )}
              {/* Both views stay mounted - toggling via `hidden` instead of
                  conditional JSX - so switching tabs doesn't tear down and
                  recreate the 3D view's WebGL context every time (React
                  StrictMode double-invokes effects, so repeated mount/unmount
                  cycles can exhaust the browser's WebGL context limit). */}
              <div hidden={view !== "2d"}>
                <RoomPlan2D
                  widthM={room.data.widthM ?? 0}
                  depthM={room.data.depthM ?? 0}
                  walls={room.data.walls}
                  openings={room.data.openings}
                  items={planItems}
                  editable
                  selectedId={selectedId}
                  onSelect={selectItem}
                  onPosChange={(itemId, pos: ItemPos) => updatePos.mutate({ id: itemId, pos })}
                  rotationDeg={rotation}
                  cutMode={cutMode}
                  onCutRect={(bounds) => {
                    setPendingCut(bounds);
                    setCutName("");
                  }}
                  pinMode={pinMode}
                  onPinPlace={(pos) => {
                    setPendingPin(pos);
                    setPinName("");
                    setPinAreaId(null);
                  }}
                />
              </div>
              <div hidden={view !== "3d"}>
                <RoomPlan3D
                  widthM={room.data.widthM ?? 0}
                  depthM={room.data.depthM ?? 0}
                  wallHeightM={room.data.wallHeightM}
                  walls={room.data.walls}
                  items={planItems}
                  selectedId={selectedId}
                  onSelect={selectItem}
                  active={view === "3d"}
                  pinMode={pinMode}
                  onPinPlace={(pos) => {
                    setPendingPin(pos);
                    setPinName("");
                    setPinAreaId(null);
                  }}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {view === "2d"
                  ? "Drag to move · drag the blue circle to rotate (shift = free angle) · drag the corner square to resize. The ⟲/⟳ buttons above only rotate the view, not the data."
                  : "Drag to orbit · scroll to zoom · click an item to select it."}
              </p>
              {room.data.items.filter((it) => !it.pos).length > 0 && (
                <p className="mt-3 text-[12px] text-muted-foreground">
                  Unplaced: {room.data.items.filter((it) => !it.pos).map((it) => it.name).join(", ")}
                </p>
              )}
            </div>

            <aside className="w-64 shrink-0 rounded-lg border border-border bg-white p-4">
              {pendingPin ? (
                <>
                  <p className="font-medium text-[14px]">Name this item</p>
                  <p className="text-[12px] text-muted-foreground mt-1">
                    at {pendingPin.xM.toFixed(2)}, {pendingPin.yM.toFixed(2)} m
                  </p>

                  <input
                    type="text"
                    placeholder="Item name"
                    className="mt-3 w-full h-8 rounded-md border border-border bg-white px-2 text-[13px]"
                    value={pinName}
                    onChange={(e) => setPinName(e.target.value)}
                    autoFocus
                  />

                  <select
                    className="mt-2 w-full h-8 rounded-md border border-border bg-white px-2 text-[13px]"
                    value={pinAreaId ?? ""}
                    onChange={(e) => setPinAreaId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="" disabled>
                      Pick a topic…
                    </option>
                    {areasList.data?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>

                  <div className="mt-3 flex gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 text-[12px]"
                      disabled={!pinName.trim() || pinAreaId == null || pinning}
                      onClick={confirmPin}
                    >
                      {pinning ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                      Create item
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => setPendingPin(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : pendingCut ? (
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
                  {cutMode
                    ? "Drag a rectangle on the plan to mark the room's area."
                    : pinMode
                      ? "Click the plan to pin a new item there."
                      : "Select an item on the plan to review it."}
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

                  {selectedItem.ownerRoomId === room.data.id && (
                    <div className="mt-4 pt-3 border-t border-border">
                      <p className="micro-label text-muted-foreground mb-1.5">Contains</p>
                      {selectedDetail.data?.children?.length ? (
                        <ul className="space-y-1 mb-2">
                          {selectedDetail.data.children.map((c) => (
                            <li key={c.id} className="flex items-center justify-between gap-2 text-[12px]">
                              <Link to={`/items/${c.id}`} className="hover:underline truncate">
                                {c.name}
                              </Link>
                              <button
                                type="button"
                                onClick={() => takeOut(c.id)}
                                className="text-muted-foreground hover:text-foreground shrink-0"
                                title="Take out"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[12px] text-muted-foreground mb-2">Nothing inside yet.</p>
                      )}

                      {attaching ? (
                        <>
                          <ItemPicker
                            placeholder="Search an item to put inside…"
                            excludeId={selectedItem.id}
                            onSelect={(item) => putInside(item.id)}
                            autoFocus
                          />
                          {attachError && <p className="mt-1 text-[11px] text-destructive">{attachError}</p>}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[12px] mt-1.5"
                            onClick={() => {
                              setAttaching(false);
                              setAttachError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => setAttaching(true)}>
                          <Plus className="h-3.5 w-3.5 mr-1" /> Put item inside…
                        </Button>
                      )}
                    </div>
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
