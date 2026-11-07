import { lazy, Suspense, useMemo, useState, type MouseEvent } from "react";
import { Link, useInRouterContext } from "react-router";
import { Box } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { trpc } from "@/providers/trpc";
import { useStableCallback } from "@/hooks/use-stable-callback";
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
 * opens the same view full size in a pan/zoom overlay (the card's own
 * `RoomPlanTabs` again, on the same query data). `size="full"` renders the
 * full-size box without a card or overlay. `view` / `onViewChange`
 * optionally control the 2D/3D tab from outside.
 *
 * The room's placed photos show as camera markers in both views; a click on
 * one opens that photo in the zoom overlay, or calls `onOpenCamera` when given.
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
        // a capture's location photo filed in another room lists here too; its camera stands in that room
        p.camera && p.roomId === roomId && !p.isCrop ? [{ id: p.photoId, title: p.title ?? "Photo", camera: p.camera }] : [],
      ),
    [roomPhotos.data, roomId],
  );
  const openCamera = useStableCallback((photoId: number) => (onOpenCamera ?? setOpenPhotoId)(photoId));
  const roomData = room.data;
  const planItems = useMemo(
    () => roomData?.items.map((it) => ({ id: it.id, name: it.name, pos: it.pos })) ?? [],
    [roomData],
  );
  const openPhoto = openPhotoId != null ? roomPhotos.data?.find((p) => p.photoId === openPhotoId) : undefined;
  const full = size === "full";

  const setView = (v: PlanView) => {
    if (v === "3d") setOpened3d(true);
    setOwnView(v);
    onViewChange?.(v);
  };

  if (!roomData) return null;

  const openZoom = (e: MouseEvent) => {
    // double-clicking the tabs or the room link shouldn't open the overlay
    if (e.target instanceof Element && e.target.closest("button, a")) return;
    setZoomOpen(true);
  };

  const tabs = (inOverlay: boolean) => (
    <RoomPlanTabs
      room={roomData}
      planItems={planItems}
      cameras={cameras}
      itemId={itemId}
      view={view}
      onViewChange={setView}
      // the overlay's copy hands a camera click back to this card's own photo state
      onOpenCamera={inOverlay ? setOpenPhotoId : openCamera}
      full={inOverlay || full}
      // the card drops its 3D view while the overlay shows its own, so
      // only one WebGL context exists at a time
      show3d={opened3d && (inOverlay || !zoomOpen)}
      onEnlarge={inOverlay || full ? undefined : () => setZoomOpen(true)}
    />
  );

  return (
    <div
      className={full ? FULL_BOX : "relative rounded-lg border border-border bg-white p-3"}
      onDoubleClick={full ? undefined : openZoom}
      title={full ? undefined : "Double-click to enlarge"}
    >
      {tabs(false)}
      {!full && (
        <ZoomOverlay
          open={zoomOpen || !!openPhoto}
          // closing a photo opened from the enlarged preview goes back to that preview
          onClose={() => (openPhoto ? setOpenPhotoId(null) : setZoomOpen(false))}
          title={openPhoto ? (openPhoto.title ?? "Photo") : roomData.name}
        >
          {openPhoto ? (
            <CameraPhoto storageKey={openPhoto.storageKey} title={openPhoto.title ?? "Photo"} />
          ) : (
            // the same queries' data at full size - no second ItemRoomPreview, no second subscription
            <div className={FULL_BOX}>{tabs(true)}</div>
          )}
        </ZoomOverlay>
      )}
    </div>
  );
}

const FULL_BOX =
  "rounded-lg bg-white p-3 flex flex-col w-[min(92vw,calc(100dvh-8rem))] h-[min(calc(92vw+2.5rem),calc(100dvh-5.5rem))]";

type RoomData = NonNullable<inferRouterOutputs<AppRouter>["rooms"]["get"]>;
type PlanItem = { id: number; name: string; pos: RoomData["items"][number]["pos"] };

/**
 * The room link, the 2D/3D tabs and both plan views - no queries of its own.
 * ItemRoomPreview renders it in the card and again, `full`, in its zoom overlay.
 * `show3d` decides whether the 3D view (and its WebGL context) is mounted.
 */
function RoomPlanTabs({
  room,
  planItems,
  cameras,
  itemId,
  view,
  onViewChange,
  onOpenCamera,
  full,
  show3d,
  onEnlarge,
}: {
  room: RoomData;
  planItems: PlanItem[];
  cameras: CameraMarker[];
  itemId: number;
  view: PlanView;
  onViewChange: (view: PlanView) => void;
  onOpenCamera: (photoId: number) => void;
  full: boolean;
  show3d: boolean;
  onEnlarge?: () => void;
}) {
  // the Flow front end has no router - there the room name is a plain link into the Workbench
  const inRouter = useInRouterContext();
  return (
    <>
      <div className="flex items-center justify-between mb-2 shrink-0">
        {inRouter ? (
          <Link to={`/rooms/${room.id}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.name}
          </Link>
        ) : (
          <a href={`/rooms/${room.id}`} className="micro-label text-muted-foreground hover:text-foreground">
            {room.name}
          </a>
        )}
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
            <button
              type="button"
              onClick={() => onViewChange("2d")}
              className={`px-2 py-0.5 rounded text-[10px] font-medium ${view === "2d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
            >
              2D
            </button>
            <button
              type="button"
              onClick={() => onViewChange("3d")}
              className={`px-2 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5 ${view === "3d" ? "bg-white shadow-sm" : "text-muted-foreground"}`}
            >
              <Box className="h-2.5 w-2.5" /> 3D
            </button>
          </div>
          {onEnlarge && (
            <button
              type="button"
              onClick={onEnlarge}
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
            widthM={room.widthM ?? 0}
            depthM={room.depthM ?? 0}
            walls={room.walls}
            openings={room.openings}
            items={planItems}
            selectedId={itemId}
            cameras={cameras}
            onSelectCamera={onOpenCamera}
          />
        </div>
        {/* in the zoom overlay the 3D view keeps its own orbit controls */}
        <div hidden={view !== "3d"} className={full ? "h-full" : undefined} data-zoom-ignore={full ? "" : undefined}>
          {show3d && (
            <Suspense fallback={null}>
              <RoomPlan3D
                widthM={room.widthM ?? 0}
                depthM={room.depthM ?? 0}
                wallHeightM={room.wallHeightM}
                walls={room.walls}
                items={planItems}
                selectedId={itemId}
                active={view === "3d"}
                cameras={cameras}
                onSelectCamera={onOpenCamera}
              />
            </Suspense>
          )}
        </div>
      </div>
    </>
  );
}

/** A camera marker's photo, full size in the zoom overlay. */
function CameraPhoto({ storageKey, title }: { storageKey: string; title: string }) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  if (!url.data?.url) return null;
  return <img src={url.data.url} alt={title} draggable={false} className="max-w-full max-h-full object-contain rounded" />;
}
