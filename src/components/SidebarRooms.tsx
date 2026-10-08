import { useMemo, useRef, useState, type DragEvent } from "react";
import { NavLink, useLocation } from "react-router";
import { Box, ChevronDown, ChevronRight, MapPin, Pencil, Square } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MergeRoomsDialog } from "@/components/MergeRoomsDialog";
import { RoomNameField } from "@/components/RoomNameField";
import { FloorField } from "@/components/FloorField";
import { RoomPicker } from "@/components/RoomPicker";
import { sortFloorNames } from "@/lib/floors";
import { setLastRoomId } from "@/lib/lastRoom";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

type RoomRow = inferRouterOutputs<AppRouter>["rooms"]["list"][number];
type RoomDrag = { id: number; houseId: number; floor: string | null };

function readRoomDrag(e: DragEvent): Omit<RoomDrag, "floor"> | null {
  try {
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return null;
    const v = JSON.parse(raw) as { kind?: string; id?: unknown; houseId?: unknown };
    if (v.kind !== "room" || typeof v.id !== "number" || typeof v.houseId !== "number") return null;
    if (!Number.isInteger(v.id) || !Number.isInteger(v.houseId)) return null;
    return { id: v.id, houseId: v.houseId };
  } catch {
    return null;
  }
}

const hasPlan = (r: RoomRow) => (r.widthM ?? 0) > 0 && (r.depthM ?? 0) > 0;

/**
 * Selected-house rooms in the Workbench sidebar: floor groups, plan/3D,
 * pencil edit/merge, and drag onto a floor (or no floor).
 */
export function SidebarRooms({
  navLinkClass,
  onNavigate,
}: {
  navLinkClass: (a: { isActive: boolean }) => string;
  onNavigate?: () => void;
}) {
  const { houseId } = useHouse();
  const location = useLocation();
  const currentId = Number((/^\/rooms\/(\d+)/.exec(location.pathname) ?? [])[1] ?? 0) || null;
  const roomsQuery = trpc.rooms.list.useQuery({ houseId });
  const roomData = roomsQuery.data ?? [];
  const [dragRoom, setDragRoom] = useState<RoomDrag | null>(null);
  const dragRoomRef = useRef<RoomDrag | null>(null);
  const [dropOn, setDropOn] = useState<{ houseId: number; floor: string } | null>(null);
  const [openFloors, setOpenFloors] = useState<Record<string, boolean>>({});
  const [editingRoom, setEditingRoom] = useState<RoomRow | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [floorTo, setFloorTo] = useState("");
  const [mergeInto, setMergeInto] = useState<number | null>(null);
  const [mergePair, setMergePair] = useState<{ fromId: number; toId: number } | null>(null);
  const utils = trpc.useUtils();
  const refreshRooms = () => {
    utils.rooms.list.invalidate();
    utils.items.listAll.invalidate();
    utils.items.get.invalidate();
    utils.rooms.get.invalidate();
  };
  const updateRoom = trpc.rooms.update.useMutation({
    onSuccess: () => {
      refreshRooms();
      setEditingRoom(null);
    },
  });
  const setRoomFloor = trpc.rooms.update.useMutation({
    onSuccess: refreshRooms,
  });

  const groups = useMemo(() => {
    const floors = sortFloorNames(roomData.map((r) => r.floor ?? "").filter(Boolean));
    const next: { floor: string; rooms: RoomRow[] }[] = floors.map((floor) => ({
      floor,
      rooms: roomData.filter((r) => (r.floor ?? "") === floor),
    }));
    next.push({ floor: "", rooms: roomData.filter((r) => !r.floor) });
    return next;
  }, [roomData]);

  const longList = roomData.length > 8;
  const floorOpen = (floor: string, rooms: RoomRow[]) => {
    if (openFloors[floor] !== undefined) return openFloors[floor];
    if (!longList) return true;
    return currentId != null && rooms.some((r) => r.id === currentId);
  };

  const canDropOn = (hid: number, floor: string) => {
    const d = dragRoomRef.current;
    return !!d && d.houseId === hid && (d.floor ?? "") !== floor;
  };
  const onDragOverGroup = (e: DragEvent, hid: number, floor: string) => {
    const d = dragRoomRef.current;
    if (!d || d.houseId !== hid) return;
    e.preventDefault();
    const ok = canDropOn(hid, floor);
    e.dataTransfer.dropEffect = ok ? "move" : "none";
    setDropOn(ok ? { houseId: hid, floor } : null);
    if (ok && longList && openFloors[floor] === false) setOpenFloors((o) => ({ ...o, [floor]: true }));
  };
  const onDragLeaveGroup = (e: DragEvent, hid: number, floor: string) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropOn((cur) => (cur?.houseId === hid && cur.floor === floor ? null : cur));
  };
  const onDropGroup = (e: DragEvent, hid: number, floor: string) => {
    e.preventDefault();
    setDropOn(null);
    const payload = readRoomDrag(e) ?? (dragRoomRef.current ? { id: dragRoomRef.current.id, houseId: dragRoomRef.current.houseId } : null);
    dragRoomRef.current = null;
    setDragRoom(null);
    if (!payload || payload.houseId !== hid) return;
    const current = roomData.find((r) => r.id === payload.id);
    if (!current) return;
    const next = floor || null;
    if ((current.floor ?? null) === next) return;
    setRoomFloor.mutate({ id: payload.id, floor: next });
  };

  const busy = updateRoom.isPending;
  const nameChanged = !!editingRoom && renameTo.trim() !== editingRoom.name;
  const floorChanged = !!editingRoom && (floorTo.trim() || null) !== (editingRoom.floor ?? null);

  if (roomsQuery.isLoading) {
    return <div className="px-2.5 py-1 text-[12px] text-[#8a8e7a]">Loading…</div>;
  }

  return (
    <>
      <nav className="px-2 space-y-0.5 select-none">
        {setRoomFloor.isError && (
          <div className="px-2.5 py-1 text-[11px] text-red-300">{setRoomFloor.error.message}</div>
        )}
        {roomData.length === 0 && <div className="px-2.5 py-1 text-[12px] text-[#8a8e7a]">No rooms yet</div>}
        {groups.map((g) => {
          const hid = g.rooms[0]?.houseId ?? houseId ?? 0;
          const isDrop = dropOn?.houseId === hid && dropOn.floor === g.floor;
          const open = floorOpen(g.floor, g.rooms);
          const key = g.floor || "nofloor";
          return (
            <div
              key={key}
              onDragOver={(e) => onDragOverGroup(e, hid, g.floor)}
              onDragLeave={(e) => onDragLeaveGroup(e, hid, g.floor)}
              onDrop={(e) => onDropGroup(e, hid, g.floor)}
              className={cn("rounded-md pb-0.5", isDrop && "bg-[#d2ff00]/10 ring-1 ring-inset ring-[#d2ff00]/70")}
            >
              <button
                type="button"
                className="w-full flex items-center gap-1 px-2.5 pt-1 micro-label text-[#8a8e7a] hover:text-[#c4c8b4]"
                onClick={() => setOpenFloors((o) => ({ ...o, [g.floor]: !open }))}
              >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>{g.floor || "no floor"}</span>
                <span className="font-data opacity-70">{g.rooms.length}</span>
              </button>
              {open &&
                g.rooms.map((r) => {
                  const isDragging = dragRoom?.id === r.id;
                  return (
                    <div
                      key={r.id}
                      draggable
                      onDragStart={(e) => {
                        if ((e.target as HTMLElement).closest("[data-no-drag]")) {
                          e.preventDefault();
                          return;
                        }
                        setRoomFloor.reset();
                        const payload: RoomDrag = { id: r.id, houseId: r.houseId, floor: r.floor ?? null };
                        dragRoomRef.current = payload;
                        e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "room", id: r.id, houseId: r.houseId }));
                        e.dataTransfer.effectAllowed = "move";
                        setDragRoom(payload);
                      }}
                      onDragEnd={() => {
                        dragRoomRef.current = null;
                        setDragRoom(null);
                        setDropOn(null);
                      }}
                      className={cn("flex items-center gap-0.5", isDragging && "opacity-50")}
                    >
                      <NavLink
                        to={`/rooms/${r.id}`}
                        title="Drag to another floor"
                        onClick={() => {
                          setLastRoomId(r.id);
                          onNavigate?.();
                        }}
                        className={(a) => cn(navLinkClass(a), "flex-1 min-w-0 cursor-grab active:cursor-grabbing")}
                      >
                        <MapPin className="h-3.5 w-3.5 text-[#b4b8a5] shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{r.name}</span>
                        <span className="font-data text-[11px] opacity-60">{r.itemCount}</span>
                      </NavLink>
                      <NavLink
                        to={hasPlan(r) ? `/rooms/${r.id}` : "#"}
                        data-no-drag
                        draggable={false}
                        onClick={(e) => {
                          if (!hasPlan(r)) e.preventDefault();
                          else onNavigate?.();
                        }}
                        title={hasPlan(r) ? "Floorplan" : "No floorplan"}
                        className={cn("shrink-0 p-0.5", hasPlan(r) ? "text-[#e0e0d0]" : "text-[#8a8e7a]/40 pointer-events-none")}
                      >
                        <Square className="h-3 w-3" />
                      </NavLink>
                      <NavLink
                        to={r.hasGeometry ? `/rooms/${r.id}?view=3d` : "#"}
                        data-no-drag
                        draggable={false}
                        onClick={(e) => {
                          if (!r.hasGeometry) e.preventDefault();
                          else onNavigate?.();
                        }}
                        title={r.hasGeometry ? "3D model" : "No 3D model"}
                        className={cn("shrink-0 p-0.5", r.hasGeometry ? "text-[#e0e0d0]" : "text-[#8a8e7a]/40 pointer-events-none")}
                      >
                        <Box className="h-3 w-3" />
                      </NavLink>
                      <button
                        type="button"
                        data-no-drag
                        draggable={false}
                        className="shrink-0 p-0.5 text-[#8a8e7a] hover:text-[#f4f4ed]"
                        title="Rename or merge this room"
                        onClick={() => {
                          setEditingRoom(r);
                          setRenameTo(r.name);
                          setFloorTo(r.floor ?? "");
                          setMergeInto(null);
                          updateRoom.reset();
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              {open && g.rooms.length === 0 && (
                <div className="mx-1 mb-1 rounded border border-dashed border-[#4a4f3a] px-2 py-1.5 text-[11px] text-[#8a8e7a]">
                  Drop a room here
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <Dialog open={!!editingRoom} onOpenChange={(o) => !o && setEditingRoom(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename or merge room</DialogTitle>
          </DialogHeader>
          {editingRoom && (
            <div className="space-y-3">
              <label className="block text-[12px]">Name
                <div className="mt-1">
                  <RoomNameField
                    value={renameTo}
                    onChange={setRenameTo}
                    rooms={roomData
                      .filter((r) => r.houseId === editingRoom.houseId)
                      .map((r) => ({ id: r.id, name: r.name, floor: r.floor }))}
                    currentId={editingRoom.id}
                    onPickExisting={(r) => setMergePair({ fromId: editingRoom.id, toId: r.id })}
                  />
                </div>
              </label>
              <label className="block text-[12px]">Floor
                <FloorField
                  id="sidebar-room-floor"
                  value={floorTo}
                  onChange={setFloorTo}
                  existing={roomData
                    .filter((r) => r.houseId === editingRoom.houseId)
                    .map((r) => r.floor ?? "")
                    .filter(Boolean)}
                />
              </label>
              <div className="text-[12px]">Or merge into another room
                <RoomPicker value={mergeInto} onChange={setMergeInto} allowCreate={false} allowNone />
              </div>
              <p className="text-[12px] text-muted-foreground">
                Pick an existing room name to merge. Floor is free text (begane grond, 1ste verdieping, zolder, …).
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingRoom(null)}>Cancel</Button>
                {mergeInto != null && mergeInto !== editingRoom.id ? (
                  <Button size="sm" disabled={busy} onClick={() => { setMergePair({ fromId: editingRoom.id, toId: mergeInto }); }}>Merge</Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy || !renameTo.trim() || !nameChanged && !floorChanged}
                    onClick={() => {
                      const clash = roomData.find(
                        (r) => r.id !== editingRoom.id && r.houseId === editingRoom.houseId && r.name.trim().toLowerCase() === renameTo.trim().toLowerCase(),
                      );
                      if (clash) {
                        setMergePair({ fromId: editingRoom.id, toId: clash.id });
                        return;
                      }
                      updateRoom.mutate({
                        id: editingRoom.id,
                        ...(nameChanged ? { name: renameTo.trim() } : {}),
                        ...(floorChanged ? { floor: floorTo.trim() || null } : {}),
                      });
                    }}
                  >
                    Save
                  </Button>
                )}
              </div>
              {updateRoom.isError && <div className="text-[12px] text-destructive">{updateRoom.error.message}</div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <MergeRoomsDialog
        open={mergePair != null}
        fromId={mergePair?.fromId ?? null}
        toId={mergePair?.toId ?? null}
        onClose={() => setMergePair(null)}
        onMerged={() => { setMergePair(null); setEditingRoom(null); refreshRooms(); }}
      />
    </>
  );
}
