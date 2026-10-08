import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { HousesMap } from "@/components/HousesMap";
import { Home, MapPin, ChevronRight, Loader2, Camera, Box, Square, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MergeRoomsDialog } from "@/components/MergeRoomsDialog";
import { RoomNameField } from "@/components/RoomNameField";
import { FloorField } from "@/components/FloorField";
import { ItemPicker } from "@/components/ItemPicker";
import { sortFloorNames } from "@/lib/floors";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

type Location = inferRouterOutputs<AppRouter>["rooms"]["list"][number];

const locationKey = (l: { id: number }) => String(l.id);

// sessionStorage, not localStorage - "keep last used during the session"
// means forgetting it again once the tab/browser closes, not forever
const SESSION_KEY = "declutter.map.lastLocation";

/**
 * Location-first entry point onto the same SSOT the item workbench uses.
 * Pick a place, not a thing: see the photo(s) for that room, pin objects
 * on them (same canvas as /annotate — just reached from a place instead
 * of a specific attachment).
 */
export default function MapPage() {
  const { houseId, houses } = useHouse();
  // Selected house; houseId null is the explicit all-houses (cross-house) view.
  const locations = trpc.rooms.list.useQuery({ houseId });
  const houseName = (id: number) => houses.find((h) => h.id === id)?.name ?? null;
  // The selected room by id, looked up in the live list: a rename shows the
  // new name, and a merged-away room falls back instead of lingering.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = useMemo(() => {
    const list = locations.data ?? [];
    if (list.length === 0) return null;
    const byId = selectedId != null ? list.find((l) => l.id === selectedId) : undefined;
    if (byId) return byId;
    let lastKey: string | null = null;
    try {
      lastKey = sessionStorage.getItem(SESSION_KEY);
    } catch {
      // storage unavailable: start at the first room
    }
    return list.find((l) => locationKey(l) === lastKey) ?? list[0];
  }, [locations.data, selectedId]);

  const selectLocation = (l: Location) => {
    setSelectedId(l.id);
    try {
      sessionStorage.setItem(SESSION_KEY, locationKey(l));
    } catch {
      // storage unavailable - selection still works for this render
    }
  };

  const photos = trpc.photos.forRoom.useQuery(
    { roomId: selected?.id ?? 0 },
    { enabled: !!selected },
  );
  const [zoom, setZoom] = useState<{ url: string; photoId: number } | null>(null);
  const [editing, setEditing] = useState<Location | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [floorTo, setFloorTo] = useState("");
  const [mergePair, setMergePair] = useState<{ fromId: number; toId: number } | null>(null);
  const utils = trpc.useUtils();
  const updateRoom = trpc.rooms.update.useMutation({
    onSuccess: () => {
      utils.rooms.list.invalidate();
      utils.rooms.get.invalidate();
      setEditing(null);
    },
  });

  const hasPlan = (l: Location) => (l.widthM ?? 0) > 0 && (l.depthM ?? 0) > 0;
  const roomsByHouse = useMemo(() => {
    const list = locations.data ?? [];
    const houseIds = [...new Set(list.map((r) => r.houseId))];
    return houseIds.map((hid) => {
      const rooms = list.filter((r) => r.houseId === hid);
      const floors = sortFloorNames(rooms.map((r) => r.floor ?? "").filter(Boolean));
      const groups: { floor: string; rooms: Location[] }[] = floors.map((floor) => ({
        floor,
        rooms: rooms.filter((r) => (r.floor ?? "") === floor),
      }));
      const unfloored = rooms.filter((r) => !r.floor);
      if (unfloored.length) groups.push({ floor: "", rooms: unfloored });
      return { houseId: hid, name: houseName(hid) ?? `House #${hid}`, groups };
    });
  }, [locations.data, houses]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Pick a Place. The map stays; each room shows whether it has a floorplan and a 3D scan. Rename a room to an existing name to merge.
      </p>

      <div className="mt-5">
        <HousesMap />
      </div>

      <div className="flex gap-6 mt-6 items-start">
        <aside className="w-64 shrink-0 rounded-lg border border-border bg-white p-2 space-y-0.5">
          <div className="micro-label text-muted-foreground px-2 py-1.5">Rooms</div>
          {locations.isLoading && <div className="px-2 py-2 text-[13px] text-muted-foreground">Loading…</div>}
          {locations.data?.length === 0 && (
            <div className="px-2 py-2 text-[13px] text-muted-foreground">
              No rooms yet.
            </div>
          )}
          {roomsByHouse.map((h) => (
            <div key={h.houseId} className="mb-2">
              {roomsByHouse.length > 1 && (
                <div className="px-2 pt-1 micro-label text-muted-foreground">{h.name}</div>
              )}
              {h.groups.map((g) => (
                <div key={`${h.houseId}-${g.floor || "nofloor"}`}>
                  <div className="px-2 pt-1 micro-label text-muted-foreground/80">{g.floor || "no floor"}</div>
                  {g.rooms.map((l) => {
                    const key = locationKey(l);
                    const isSelected = selected && locationKey(selected) === key;
                    return (
                      <div
                        key={key}
                        className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-[13px] ${
                          isSelected ? "bg-muted" : "hover:bg-muted/50"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => selectLocation(l)}
                          className="flex-1 min-w-0 flex items-center gap-2 text-left"
                        >
                          <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="flex-1 min-w-0 truncate font-medium">{l.name}</span>
                          <span className="font-data text-[11px] text-muted-foreground">{l.itemCount}</span>
                        </button>
                        <Link
                          to={hasPlan(l) ? `/rooms/${l.id}` : "#"}
                          onClick={(e) => { if (!hasPlan(l)) e.preventDefault(); }}
                          title={hasPlan(l) ? "Floorplan" : "No floorplan"}
                          className={cn("shrink-0", hasPlan(l) ? "text-foreground" : "text-muted-foreground/30 pointer-events-none")}
                        >
                          <Square className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to={l.hasGeometry ? `/rooms/${l.id}?view=3d` : "#"}
                          onClick={(e) => { if (!l.hasGeometry) e.preventDefault(); }}
                          title={l.hasGeometry ? "3D model" : "No 3D model"}
                          className={cn("shrink-0", l.hasGeometry ? "text-foreground" : "text-muted-foreground/30 pointer-events-none")}
                        >
                          <Box className="h-3.5 w-3.5" />
                        </Link>
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title="Rename room"
                          onClick={() => { setEditing(l); setRenameTo(l.name); setFloorTo(l.floor ?? ""); updateRoom.reset(); }}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </aside>

        <div className="flex-1 min-w-0">
          {!selected ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-16 text-center text-[13px] text-muted-foreground">
              <Home className="h-6 w-6 mx-auto mb-2 opacity-50" />
              Pick a room on the left to see its photos and pins.
            </div>
          ) : photos.isLoading ? (
            <div className="text-[13px] text-muted-foreground px-2">Loading photos…</div>
          ) : !photos.data?.length ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-16 text-center text-[13px] text-muted-foreground">
              No source photos found for <b>{selected.name}</b> yet — the pool fills in automatically as items
              from this room get detected via the inbox.
            </div>
          ) : (
            <>
              <div className="micro-label text-muted-foreground mb-2">
                {selected.name} — {photos.data.length} photo{photos.data.length === 1 ? "" : "s"}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {photos.data.map((p) => (
                  <PhotoCard
                    key={p.id}
                    storageKey={p.storageKey}
                    captureId={p.id}
                    roomId={selected.id}
                    onPlan={p.camera != null}
                    onOpen={(url, photoId) => setZoom({ url, photoId })}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {zoom && (
        <MapPhotoZoom
          url={zoom.url}
          photoId={zoom.photoId}
          title={selected?.name}
          onClose={() => setZoom(null)}
        />
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit room</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <label className="block text-[12px]">Name
                <div className="mt-1">
                  <RoomNameField
                    value={renameTo}
                    onChange={setRenameTo}
                    rooms={(locations.data ?? [])
                      .filter((r) => r.houseId === editing.houseId)
                      .map((r) => ({ id: r.id, name: r.name, floor: r.floor }))}
                    currentId={editing.id}
                    onPickExisting={(r) => setMergePair({ fromId: editing.id, toId: r.id })}
                  />
                </div>
              </label>
              <label className="block text-[12px]">Floor
                <FloorField
                  id="map-room-floor"
                  value={floorTo}
                  onChange={setFloorTo}
                  existing={(locations.data ?? [])
                    .filter((r) => r.houseId === editing.houseId)
                    .map((r) => r.floor ?? "")
                    .filter(Boolean)}
                />
              </label>
              <p className="text-[12px] text-muted-foreground">
                Pick an existing room name from the list to merge. Floor is free text (begane grond, 1ste verdieping, zolder, …).
              </p>
              {updateRoom.isError && <p className="text-[12px] text-destructive">{updateRoom.error.message}</p>}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                <Button
                  size="sm"
                  disabled={
                    updateRoom.isPending ||
                    !renameTo.trim() ||
                    (renameTo.trim() === editing.name && (floorTo.trim() || null) === (editing.floor ?? null))
                  }
                  onClick={() => {
                    const name = renameTo.trim();
                    const clash = (locations.data ?? []).find(
                      (r) => r.id !== editing.id && r.houseId === editing.houseId && r.name.trim().toLowerCase() === name.toLowerCase(),
                    );
                    if (clash) {
                      setMergePair({ fromId: editing.id, toId: clash.id });
                      return;
                    }
                    const floor = floorTo.trim() || null;
                    updateRoom.mutate({
                      id: editing.id,
                      ...(name !== editing.name ? { name } : {}),
                      ...(floor !== (editing.floor ?? null) ? { floor } : {}),
                    });
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <MergeRoomsDialog
        open={mergePair != null}
        fromId={mergePair?.fromId ?? null}
        toId={mergePair?.toId ?? null}
        onClose={() => setMergePair(null)}
        onMerged={() => { setMergePair(null); setEditing(null); }}
      />
    </div>
  );
}

/**
 * One photo in the pool. The pool is keyed by *capture* id (the original
 * source photo), but the pin canvas at /annotate works on a *photo* id - a
 * capture isn't pinnable until it also has a photo. Make one on demand
 * (find-or-create, so repeat visits reuse the same row) before navigating in.
 * The same goes for "Place on the plan": the plan page places a photo id.
 */
function PhotoCard({
  storageKey,
  captureId,
  roomId,
  onPlan,
  onOpen,
}: {
  storageKey: string;
  captureId: number;
  roomId: number;
  /** the capture's location photo stands on this room's plan as a camera */
  onPlan: boolean;
  onOpen: (url: string, photoId: number) => void;
}) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  const navigate = useNavigate();
  const ensure = trpc.photos.ensureForCapture.useMutation();
  const [going, setGoing] = useState<"pin" | "place" | "zoom" | null>(null);
  const go = (to: "pin" | "place" | "zoom") => {
    if (to === "zoom" && !url.data?.url) return;
    setGoing(to);
    ensure.mutate(
      { captureId, roomId },
      {
        onSuccess: (res) => {
          if (to === "zoom") onOpen(url.data!.url!, res.photoId);
          else navigate(to === "pin" ? `/annotate/${res.photoId}` : `/rooms/${roomId}?placePhoto=${res.photoId}`);
        },
        onSettled: () => setGoing(null),
      },
    );
  };

  return (
    <div className="relative rounded-lg border border-border bg-white p-2">
      {url.data?.url && (
        <button
          type="button"
          onClick={() => go("zoom")}
          className="absolute top-3 right-3 h-6 w-6 flex items-center justify-center rounded bg-white/85 text-[13px] leading-none text-muted-foreground hover:text-foreground shadow-sm"
          title="Enlarge"
          aria-label="Enlarge"
        >
          ⤢
        </button>
      )}
      {url.data?.url ? (
        <button type="button" className="block w-full" onClick={() => go("zoom")} title="Open and pin">
          <img
            src={url.data.url}
            alt=""
            className="w-full aspect-video object-cover rounded cursor-zoom-in"
          />
        </button>
      ) : (
        <div className="w-full aspect-video rounded bg-muted/40" />
      )}
      {onPlan && (
        <span
          className="absolute top-3 left-3 flex items-center gap-1 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm"
          title="This photo stands on the room's plan as a camera"
        >
          <Camera className="h-3 w-3" /> on the plan
        </span>
      )}
      <button
        onClick={() => go("pin")}
        disabled={ensure.isPending}
        className="mt-1.5 flex items-center gap-1 text-[12px] text-primary hover:underline disabled:opacity-50"
      >
        {going === "pin" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>Pin objects on this photo <ChevronRight className="h-3 w-3" /></>
        )}
      </button>
      <button
        onClick={() => go("place")}
        disabled={ensure.isPending}
        className="mt-0.5 flex items-center gap-1 text-[12px] text-primary hover:underline disabled:opacity-50"
      >
        {going === "place" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>Place on the plan <ChevronRight className="h-3 w-3" /></>
        )}
      </button>
    </div>
  );
}

function MapPhotoZoom({
  url,
  photoId,
  title,
  onClose,
}: {
  url: string;
  photoId: number;
  title?: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const pins = trpc.pins.listForPhoto.useQuery({ photoId });
  const addPin = trpc.pins.add.useMutation({
    onSuccess: () => {
      utils.pins.listForPhoto.invalidate({ photoId });
      utils.items.placementSummary.invalidate();
    },
  });
  const [placeMode, setPlaceMode] = useState(false);
  const [pending, setPending] = useState<{ xPct: number; yPct: number } | null>(null);
  const [label, setLabel] = useState("");
  const [item, setItem] = useState<{ id: number; name: string } | null>(null);

  const save = () => {
    if (!pending) return;
    addPin.mutate(
      {
        photoId,
        xPct: pending.xPct,
        yPct: pending.yPct,
        label: item?.name ?? label.trim(),
        itemId: item?.id,
      },
      {
        onSuccess: () => {
          setPending(null);
          setLabel("");
          setItem(null);
          setPlaceMode(false);
        },
      },
    );
  };

  return (
    <ZoomOverlay
      open
      onClose={onClose}
      title={title}
      placeMode={placeMode && pending == null}
      onPlace={(pct) => {
        setPending(pct);
        setPlaceMode(false);
      }}
      toolbarExtra={
        <div className="flex items-center gap-2 mr-2 min-w-0">
          <button
            type="button"
            className={cn(
              "h-8 px-2 rounded-md text-[12px] text-white/90 hover:bg-white/15",
              placeMode && "bg-white/20",
            )}
            onClick={() => {
              setPlaceMode((p) => !p);
              setPending(null);
            }}
          >
            {placeMode ? "Click the photo to pin" : "Pin"}
          </button>
          {pending && (
            <div className="flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 min-w-0">
              <div className="w-48">
                <ItemPicker
                  autoFocus
                  placeholder="link a Thing…"
                  onSelect={(sel) => {
                    setItem(sel);
                    setLabel(sel.name);
                  }}
                />
              </div>
              <input
                className="w-28 rounded border border-white/20 bg-transparent px-1.5 py-1 text-[12px] text-white"
                placeholder="or label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
              <Button size="sm" className="h-7 text-[11px]" disabled={addPin.isPending} onClick={save}>
                Save pin
              </Button>
              <button type="button" className="text-[11px] text-white/70" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      }
    >
      <div data-pin-canvas className="relative inline-block max-w-full max-h-full">
        <img src={url} alt="" draggable={false} className="max-w-full max-h-[80vh] object-contain rounded" />
        {(pins.data ?? [])
          .filter((p) => p.status === "confirmed")
          .map((p) => (
            <span
              key={p.id}
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary shadow"
              style={{ left: `${p.xPct}%`, top: `${p.yPct}%` }}
              title={p.itemName ?? p.label ?? "pin"}
            />
          ))}
        {pending && (
          <span
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-amber-400 shadow"
            style={{ left: `${pending.xPct}%`, top: `${pending.yPct}%` }}
          />
        )}
      </div>
    </ZoomOverlay>
  );
}
