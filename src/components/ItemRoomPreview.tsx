import { lazy, Suspense, useMemo, useState, type MouseEvent } from "react";
import { Link, useInRouterContext } from "react-router";
import { Box } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D } from "@/components/RoomPlan2D";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import type { CameraMarker } from "@/components/RoomPlan3D";
const RoomPlan3D = lazy(() => import("@/components/RoomPlan3D").then((m) => ({ default: m.RoomPlan3D })));

type PlanView = "2d" | "3d";

/**
 * Compact, read-only 2D/3D room-plan preview for an item's detail page -
 * shows where the item sits among its room's other items, highlighted.
 * Renders nothing when the item has no room placement yet.
 *
 * `size="card"` (default) is the small card; double-click or its ⤢ button
 * opens the same view at `size="full"` in a pan/zoom overlay. `view` /
 * `onViewChange` optionally control the 2D/3D tab from outside.
 *
 * The room's placed photos show as camera markers in both views; a click on
 * one opens that photo in the zoom overlay. `onOpenCamera` is how the
 * overlay's own full-size copy hands such a click back to its card.
 */
export function ItemRoomPreview({
  roomId,
  itemId,
  size = "card",
  view: viewProp,
  onViewChange,
  onOpenCamera,
}: {
  roomId: number;
  itemId: number;
  size?: "card" | "full";
  view?: PlanView;
  onViewChange?: (view: PlanView) => void;
  onOpenCamera?: (photoId: number) => void;
}) {
  const room = trpc.rooms.get.useQuery({ id: roomId });
  // the Flow front end has no router - there the room name is a plain link into the Workbench
  const inRouter = useInRouterContext();
  const [ownView, setOwnView] = useState<PlanView>(viewProp ?? "2d");
  const view = viewProp ?? ownView;
  // three.js (and its WebGL context) is only loaded once the 3D tab is opened
  const [opened3d, setOpened3d] = useState(view === "3d");
  const [zoomOpen, setZoomOpen] = useState(false);
  // a camera marker's photo shown in the zoom overlay (over the enlarged preview, if that is open)
  const [openPhotoId, setOpenPhotoId] = useState<number | null>(null);
  const roomPhotos = trpc.photos.roomPhotos.useQuery({ roomId }, { enabled: !!room.data });
  const cameras = useMemo<CameraMarker[]>(
    () =>
      (roomPhotos.data ?? []).flatMap((p) =>
        p.camera && !p.isCutout ? [{ id: p.photoId, title: p.title ?? "Photo", camera: p.camera }] : [],
      ),
    [roomPhotos.data],
  );
  const openCamera = onOpenCamera ?? setOpenPhotoId;
  const openPhoto = openPhotoId != null ? roomPhotos.data?.find((p) => p.photoId === openPhotoId) : undefined;
  const full = size === "full";

  const setView = (v: PlanView) => {
    if (v === "3d") setOpened3d(true);
    setOwnView(v);
    onViewChange?.(v);
  };

  if (!room.data) return null;
  const planItems = room.data.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos }));

  const openZoom = (e: MouseEvent) => {
    // double-clicking the tabs or the room link shouldn't open the overlay
    if (e.target instanceof Element && e.target.closest("button, a")) return;
    setZoomOpen(true);
  };

  return (
    <div
      className={
        full
          ? "rounded-lg bg-white p-3 flex flex-col w-[min(92vw,calc(100dvh-8rem))] h-[min(calc(92vw+2.5rem),calc(100dvh-5.5rem))]"
          : "relative rounded-lg border border-border bg-white p-3"
      }
      onDoubleClick={full ? undefined : openZoom}
      title={full ? undefined : "Double-click to enlarge"}
    >
      <div className="flex items-center justify-between mb-2 shrink-0">
        {inRouter ? (
          <Link to={`/rooms/${roomId}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.data.name}
          </Link>
        ) : (
          <a href={`/rooms/${roomId}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.data.name}
          </a>
        )}
        <div className="flex items-center gap-1">
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
              onClick={() => setView("3d")}
              className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5 ${view === "3d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
            >
              <Box className="h-2.5 w-2.5" /> 3D
            </button>
          </div>
          {!full && (
            <button
              type="button"
              onClick={() => setZoomOpen(true)}
              className="h-5 w-5 flex items-center justify-center rounded text-[13px] leading-none text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Enlarge"
              aria-label="Enlarge"
            >
              ⤢
            </button>
          )}
        </div>
      </div>
      <div className={full ? "flex-1 min-h-0 w-full [&_svg]:w-full [&_svg]:h-full" : "max-w-[220px] mx-auto"}>
        {/* once opened, both views stay mounted so switching tabs doesn't
            tear down the 3D view's WebGL context */}
        <div hidden={view !== "2d"} className={full ? "h-full" : undefined}>
          <RoomPlan2D
            widthM={room.data.widthM ?? 0}
            depthM={room.data.depthM ?? 0}
            walls={room.data.walls}
            openings={room.data.openings}
            items={planItems}
            selectedId={itemId}
            cameras={cameras}
            onSelectCamera={openCamera}
          />
        </div>
        {/* in the zoom overlay the 3D view keeps its own orbit controls */}
        <div hidden={view !== "3d"} className={full ? "h-full" : undefined} data-zoom-ignore={full ? "" : undefined}>
          {/* the card drops its 3D view while the overlay shows its own, so
              only one WebGL context exists at a time */}
          {opened3d && !zoomOpen && (
          <Suspense fallback={null}>
          <RoomPlan3D
            widthM={room.data.widthM ?? 0}
            depthM={room.data.depthM ?? 0}
            wallHeightM={room.data.wallHeightM}
            walls={room.data.walls}
            items={planItems}
            selectedId={itemId}
            active={view === "3d"}
            cameras={cameras}
            onSelectCamera={openCamera}
          />
          </Suspense>
          )}
        </div>
      </div>
      {!full && (
        <ZoomOverlay
          open={zoomOpen || !!openPhoto}
          // closing a photo opened from the enlarged preview goes back to that preview
          onClose={() => (openPhoto ? setOpenPhotoId(null) : setZoomOpen(false))}
          title={openPhoto ? (openPhoto.title ?? "Photo") : room.data.name}
        >
          {openPhoto ? (
            <CameraPhoto storageKey={openPhoto.storageKey} title={openPhoto.title ?? "Photo"} />
          ) : (
            <ItemRoomPreview
              roomId={roomId}
              itemId={itemId}
              size="full"
              view={view}
              onViewChange={setView}
              onOpenCamera={setOpenPhotoId}
            />
          )}
        </ZoomOverlay>
      )}
    </div>
  );
}

/** A camera marker's photo, full size in the zoom overlay. */
function CameraPhoto({ storageKey, title }: { storageKey: string; title: string }) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  if (!url.data?.url) return null;
  return <img src={url.data.url} alt={title} draggable={false} className="max-w-full max-h-full object-contain rounded" />;
}
