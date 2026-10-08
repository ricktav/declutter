import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomPlan2D, type CameraMarker, type PlanMove } from "@/components/RoomPlan2D";
import { ScanDiffList } from "@/components/ScanDiffList";
import { moveLabel } from "@/lib/scanDiff";
import { RoomPlan3D } from "@/components/RoomPlan3D";
import { Button } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { ItemPicker } from "@/components/ItemPicker";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { RoomPhotoPool } from "@/components/RoomPhotoPool";
import { PhotoRoomSelect } from "@/components/PhotoRoomSelect";
import { invalidatePhotoPlace } from "@/components/PhotoPlaceDialog";
import { applyStacking } from "@/lib/roomStacking";
import {
  Loader2,
  Check,
  X,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  MapPin,
  Box,
  Plus,
  Camera,
  Maximize2,
  Sparkles,
  ScanLine,
  Undo2,
} from "lucide-react";
import type { ItemPos, PhotoCamera } from "@db/schema";

const CAMERA_DEFAULT: Omit<PhotoCamera, "xM" | "yM"> = { headingDeg: 0, fovDeg: 60, heightM: 1.5 };

const SCAN_SOURCE: Record<string, string> = {
  geojson: "GeoJSON file",
  roomplan: "iPhone LiDAR",
  mappedin: "MappedIn",
  manual: "by hand",
};
const scanWhen = (d: Date | string) =>
  new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

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
  const [searchParams, setSearchParams] = useSearchParams();
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
  // Snap to wall: an explicit per-Thing action; the note is tied to the Thing it was for
  const [snapNote, setSnapNote] = useState<{ itemId: number; text: string; error: boolean } | null>(null);
  const snapToWall = trpc.items.snapToWall.useMutation({
    onSuccess: (r, vars) => {
      void utils.rooms.get.invalidate({ id });
      void utils.items.listAll.invalidate();
      setSnapNote({ itemId: vars.id, text: `Snapped to the ${r.wall.side} wall · ${r.movedM} m`, error: false });
    },
    onError: (e, vars) => setSnapNote({ itemId: vars.id, text: e.message, error: true }),
  });
  useEffect(() => {
    if (!snapNote || snapNote.error) return;
    const t = setTimeout(() => setSnapNote(null), 4000);
    return () => clearTimeout(t);
  }, [snapNote]);
  const [view, setView] = useState<"2d" | "3d">(searchParams.get("view") === "3d" ? "3d" : "2d");
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
    cancelCameraPlace();
    setSelectedCameraId(null);
    setConfirmRemoveCamera(false);
    setAttaching(false);
    setAttachError(null);
  };

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

  // Place mode: put an existing, unplaced Thing of this room on the plan.
  // Entered from the unplaced list's "Place" button or `?placeItem=<id>`
  // (the item view's "Place on the plan"). The param is only honoured for
  // a Thing of this room without a position - anything else gets a notice
  // and nothing is written.
  const placeParam = Number(searchParams.get("placeItem"));
  const placeParamId = Number.isInteger(placeParam) && placeParam > 0 ? placeParam : null;
  const placeParamItem = placeParamId != null ? room.data?.items.find((it) => it.id === placeParamId) : undefined;
  // The 2D plan is width x depth: without both (walls alone draw no plan)
  // there is nowhere to click, so place mode is never entered. The notice
  // above the plan carries a form to give the room a size.
  const roomSized = (room.data?.widthM ?? 0) > 0 && (room.data?.depthM ?? 0) > 0;
  const sizeNotice = room.data ? `Give ${room.data.name} a size or a scan first, then place Things on its plan.` : "";
  /** A Thing inside another Thing (a drawer's content) has no box of its
   * own: the host says where it is. */
  const hostNameOf = (parentId: number | null | undefined) =>
    parentId == null ? null : (room.data?.items.find((it) => it.id === parentId)?.name ?? "another Thing");
  const insideTitle = (parentId: number | null | undefined) => `Inside ${hostNameOf(parentId)}: placed with it`;
  /** Gone (archived) and rejected Things are not placed: they are not in the room any more. */
  const placeable = (it: { status: string; verificationStatus: string }) =>
    it.status === "active" && it.verificationStatus !== "rejected";
  const placeParamOk =
    roomSized &&
    placeParamItem != null &&
    placeable(placeParamItem) &&
    placeParamItem.ownerRoomId === id &&
    !placeParamItem.pos &&
    placeParamItem.parentId == null;
  const placeNotice =
    placeParamId == null || !room.data || placeParamOk
      ? null
      : !placeParamItem || placeParamItem.ownerRoomId !== id
        ? `That Thing is not in ${room.data.name}, so it was not placed here.`
        : !placeable(placeParamItem)
          ? `${placeParamItem.name} is gone or rejected, so it is not placed.`
          : placeParamItem.pos
            ? `${placeParamItem.name} is already placed on the plan.`
            : placeParamItem.parentId != null
              ? `${insideTitle(placeParamItem.parentId)}.`
              : null; // unsized: the size notice above the plan says it (and place mode starts once sized)
  const [placingManual, setPlacingManual] = useState<{ id: number; name: string } | null>(null);
  const placeParamTarget = placeParamOk && placeParamItem ? placeParamItem : null;
  const placing = useMemo(
    () => placingManual ?? (placeParamTarget ? { id: placeParamTarget.id, name: placeParamTarget.name } : null),
    [placingManual, placeParamTarget],
  );
  const [placingBusy, setPlacingBusy] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  const dropPlaceParam = () => {
    if (!searchParams.has("placeItem")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("placeItem");
    setSearchParams(next, { replace: true });
  };
  const startPlace = (item: { id: number; name: string }) => {
    if (!roomSized) return;
    dropPlaceParam();
    setPlaceError(null);
    setPlacingManual(item);
    cancelCameraPlace();
    setPinMode(false);
    setPendingPin(null);
    setCutMode(false);
    setPendingCut(null);
    setSelectedId(null);
  };
  const cancelPlace = () => {
    setPlacingManual(null);
    setPlaceError(null);
    dropPlaceParam();
  };
  /** Same footprint and stacking as a new pin, but for a Thing that
   * already exists. */
  const placeAt = async (at: { xM: number; yM: number }) => {
    if (!placing || placingBusy) return;
    const target = placing;
    // Hold the target in state and drop `?placeItem=` before the write: the
    // mutation awaits the room refetch, and with the param still set the
    // freshly placed Thing would flash the "already placed" notice.
    setPlacingManual(target);
    dropPlaceParam();
    setPlaceError(null);
    setPlacingBusy(true);
    try {
      const basePos = { xM: at.xM, yM: at.yM, wM: 0.5, dM: 0.5, rotDeg: 0 };
      await updatePos.mutateAsync({ id: target.id, pos: applyStacking(target.id, basePos, planItems) });
      utils.items.get.invalidate({ id: target.id });
      utils.items.placement.invalidate({ itemId: target.id });
      utils.items.placementSummary.invalidate();
      cancelPlace();
      setSelectedId(target.id);
    } catch (e) {
      // stay in place mode so another click can retry
      setPlaceError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlacingBusy(false);
    }
  };
  const onPlanClick = (pos: { xM: number; yM: number }) => {
    if (placing) {
      placeAt(pos);
      return;
    }
    setPendingPin(pos);
    setPinName("");
    setPinAreaId(null);
  };

  // ---- Photos on the plan: camera markers -------------------------------
  // A full photo of this room stands on the plan as a camera (dot + view
  // wedge). "Place" (or `?placePhoto=<photoId>`, from the Photos page and
  // the item view) asks suggestCamera for a start, draws it as a ghost, and
  // the next plan click stands the photo there with the suggested heading.
  const roomPhotos = trpc.photos.roomPhotos.useQuery({ roomId: id }, { enabled: Number.isFinite(id) });
  // a capture's location photo can be listed here while filed in no room, or
  // another: each row's own roomId says; a camera only stands in its room
  const onPlanPhotos = useMemo(
    () => (roomPhotos.data ?? []).filter((p) => p.camera != null && p.roomId === id && !p.isCrop),
    [roomPhotos.data, id],
  );
  const [selectedCameraId, setSelectedCameraId] = useState<number | null>(null);
  const [confirmRemoveCamera, setConfirmRemoveCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [zoomPhoto, setZoomPhoto] = useState<{ storageKey: string; title: string } | null>(null);
  const selectedCamera = onPlanPhotos.find((p) => p.photoId === selectedCameraId) ?? null;

  const placePhotoRaw = Number(searchParams.get("placePhoto"));
  const placePhotoId = Number.isInteger(placePhotoRaw) && placePhotoRaw > 0 ? placePhotoRaw : null;
  const placePhotoDetail = trpc.photos.get.useQuery({ id: placePhotoId ?? -1 }, { enabled: placePhotoId != null });
  const placePhotoRow = placePhotoDetail.data?.photo ?? null;
  const placePhotoOk =
    roomSized && placePhotoRow != null && placePhotoRow.cropBox == null && placePhotoRow.roomId === id;
  const placePhotoNotice =
    placePhotoId == null || !room.data || placePhotoDetail.isLoading || placePhotoOk
      ? null
      : !placePhotoRow
        ? "That photo was not found, so nothing was placed."
        : placePhotoRow.cropBox != null
          ? "That photo is a cutout of a Thing, not a viewpoint: it does not stand on the plan."
          : placePhotoRow.roomId == null
            ? "That photo has no room yet, so it was not placed here. Assign a room below."
            : placePhotoRow.roomId !== id
              ? `That photo is not in ${room.data.name}, so it was not placed here.`
              : null; // unsized: the size notice above the plan says it
  const [cameraPlacingManual, setCameraPlacingManual] = useState<{ photoId: number; title: string } | null>(null);
  const cameraPlacing =
    cameraPlacingManual ??
    (placePhotoOk && placePhotoRow ? { photoId: placePhotoRow.id, title: placePhotoRow.title || `Photo #${placePhotoRow.id}` } : null);
  const suggestion = trpc.photos.suggestCamera.useQuery(
    { id: cameraPlacing?.photoId ?? -1 },
    { enabled: cameraPlacing != null && roomSized, staleTime: 0, retry: false },
  );
  const [cameraBusy, setCameraBusy] = useState(false);

  const setCamera = trpc.photos.setCamera.useMutation();
  /** Write a camera (null takes it off the plan). The list is updated first
   * so a dragged marker stays where it was dropped; a failure refetches. */
  const writeCamera = async (photoId: number, camera: PhotoCamera | null) => {
    setCameraError(null);
    utils.photos.roomPhotos.setData({ roomId: id }, (old) =>
      old?.map((p) => (p.photoId === photoId ? { ...p, camera } : p)),
    );
    try {
      await setCamera.mutateAsync({ id: photoId, camera });
      return true;
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      void utils.photos.roomPhotos.invalidate({ roomId: id });
      void utils.photos.get.invalidate({ id: photoId });
      void utils.items.placement.invalidate();
    }
  };

  const setPhotoRoom = trpc.photos.setRoom.useMutation({
    onSuccess: (res) => {
      invalidatePhotoPlace(utils);
      if (res.roomId != null && res.roomId !== id) {
        navigate(`/rooms/${res.roomId}?placePhoto=${res.id}`);
      }
    },
  });

  const dropPlacePhotoParam = () => {
    if (!searchParams.has("placePhoto")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("placePhoto");
    setSearchParams(next, { replace: true });
  };
  const cancelCameraPlace = () => {
    setCameraPlacingManual(null);
    setCameraError(null);
    dropPlacePhotoParam();
  };
  /** The click gives the position; heading, view and height come from the
   * suggestion (the defaults when it failed). */
  const placeCameraAt = async (at: { xM: number; yM: number }) => {
    if (!cameraPlacing || cameraBusy || suggestion.isLoading) return;
    const target = cameraPlacing;
    const base = suggestion.data?.camera ?? { xM: at.xM, yM: at.yM, ...CAMERA_DEFAULT };
    // hold the target and drop `?placePhoto=` before the write, as placeAt does
    setCameraPlacingManual(target);
    dropPlacePhotoParam();
    setCameraBusy(true);
    try {
      const ok = await writeCamera(target.photoId, { ...base, xM: at.xM, yM: at.yM });
      if (ok) {
        setCameraPlacingManual(null);
        setSelectedCameraId(target.photoId);
        setConfirmRemoveCamera(false);
      }
    } finally {
      setCameraBusy(false);
    }
  };
  const suggestForSelected = async () => {
    if (!selectedCamera) return;
    setCameraError(null);
    try {
      const s = await utils.photos.suggestCamera.fetch({ id: selectedCamera.photoId }, { staleTime: 0 });
      await writeCamera(selectedCamera.photoId, s.camera);
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
    }
  };
  const selectCamera = (photoId: number) => {
    setSelectedCameraId(photoId);
    setConfirmRemoveCamera(false);
    setCameraError(null);
    setSelectedId(null);
  };
  // 3D draws the placed photos only (no ghost), memoised: the 3D scene rebuilds when its cameras change
  const cameras3d = useMemo<CameraMarker[]>(
    () => (roomSized ? onPlanPhotos.map((p) => ({ id: p.photoId, title: photoTitle(p), camera: p.camera! })) : []),
    [roomSized, onPlanPhotos],
  );
  const openCameraPhoto = (photoId: number) => {
    const p = onPlanPhotos.find((x) => x.photoId === photoId);
    if (p) setZoomPhoto({ storageKey: p.storageKey, title: photoTitle(p) });
  };
  const cameraMarkers: CameraMarker[] = roomSized
    ? [
        ...onPlanPhotos.map((p) => ({ id: p.photoId, title: photoTitle(p), camera: p.camera! })),
        ...(cameraPlacing && suggestion.data
          ? [{ id: cameraPlacing.photoId, title: cameraPlacing.title, camera: suggestion.data.camera, ghost: true }]
          : []),
      ]
    : [];

  const onEscape = useEffectEvent(() => {
    cancelPlace();
    cancelCameraPlace();
  });
  const anyPlacing = placing != null || cameraPlacing != null;
  useEffect(() => {
    if (!anyPlacing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyPlacing]);

  // ---- Scans: compare a scan with the one before, undo the latest --------
  // Selecting a scan ghosts the outline from before it under the current
  // walls and draws an arrow for each Thing it moved. Only the newest scan
  // that is not undone yet can be undone.
  const scans = trpc.rooms.scans.useQuery({ roomId: id }, { enabled: Number.isFinite(id) });
  const [selectedScanId, setSelectedScanId] = useState<number | null>(null);
  const [confirmUndoId, setConfirmUndoId] = useState<number | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const scanDiff = trpc.rooms.scanDiff.useQuery({ scanId: selectedScanId ?? -1 }, { enabled: selectedScanId != null });
  const latestLiveScanId = scans.data?.find((s) => !s.revertedAt)?.id ?? null;
  const diff = selectedScanId != null && scanDiff.data?.scan.id === selectedScanId ? scanDiff.data : null;
  const scanMoves = useMemo<PlanMove[]>(
    () =>
      (diff?.changes ?? [])
        .filter((c) => c.action === "moved" && c.posBefore && c.posAfter)
        .map((c) => ({ from: c.posBefore!, to: c.posAfter!, label: moveLabel(c) })),
    [diff],
  );
  const revertScan = trpc.rooms.revertScan.useMutation({
    onSuccess: (r) => {
      setConfirmUndoId(null);
      setSelectedScanId(null);
      setUndoNote(
        `Scan undone: ${r.restored} ${r.restored === 1 ? "Thing" : "Things"} put back` +
          (r.deleted ? `, ${r.deleted} new deleted` : "") +
          (r.kept ? `, ${r.kept} new kept (someone worked on ${r.kept === 1 ? "it" : "them"})` : "") +
          ".",
      );
      void utils.items.listAll.invalidate();
      void utils.rooms.scans.invalidate({ roomId: id });
      void utils.rooms.scanDiff.invalidate();
      // the undo may have deleted the selected Thing: drop the selection once the room is fresh
      void utils.rooms.get.invalidate({ id }).then(() => {
        const fresh = utils.rooms.get.getData({ id });
        if (fresh) setSelectedId((cur) => (cur != null && !fresh.items.some((it) => it.id === cur) ? null : cur));
      });
    },
  });

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
        roomId: room.data.id,
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
    <div className="max-w-7xl mx-auto px-6 py-8">
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

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="min-w-0">
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
                    cancelCameraPlace();
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
                      cancelPlace();
                      cancelCameraPlace();
                      setSelectedCameraId(null);
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
                        cancelPlace();
                        cancelCameraPlace();
                        setSelectedCameraId(null);
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
              {placing && (
                <div className="mb-1.5 flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-[12px] text-sky-900">
                  {placingBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                  <span>
                    Click where <b>{placing.name}</b> stands
                  </span>
                  <span className="text-muted-foreground">· Esc cancels</span>
                  {placeError && <span className="text-destructive">Not placed: {placeError}</span>}
                  <Button size="sm" variant="outline" className="h-6 text-[11px] ml-auto" onClick={cancelPlace}>
                    Cancel
                  </Button>
                </div>
              )}
              {cameraPlacing && (
                <div className="mb-1.5 flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-[12px] text-violet-900">
                  {cameraBusy || suggestion.isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5" />
                  )}
                  <span>
                    Click where <b>{cameraPlacing.title}</b> was taken
                    {suggestion.data?.basis === "pins"
                      ? " · the dashed marker is a guess from its pinned Things"
                      : suggestion.data
                        ? " · the dashed marker is the room's centre"
                        : ""}
                  </span>
                  <span className="text-muted-foreground">· Esc cancels</span>
                  {suggestion.error && <span className="text-destructive">{suggestion.error.message}</span>}
                  {cameraError && <span className="text-destructive">Not placed: {cameraError}</span>}
                  <Button size="sm" variant="outline" className="h-6 text-[11px] ml-auto" onClick={cancelCameraPlace}>
                    Cancel
                  </Button>
                </div>
              )}
              {!roomSized && (
                <div className="mb-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900">
                  <p>{sizeNotice}</p>
                  <RoomSizeForm roomId={id} widthM={room.data.widthM} depthM={room.data.depthM} />
                </div>
              )}
              {placeNotice && (
                <div className="mb-1.5 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] text-amber-900">
                  <span>{placeNotice}</span>
                  <button className="ml-auto" title="Dismiss" onClick={dropPlaceParam}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {placePhotoNotice && (
                <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] text-amber-900">
                  <span className="flex-1 min-w-0">{placePhotoNotice}</span>
                  {placePhotoRow?.roomId == null && placePhotoId != null && (
                    <div className="w-44">
                      <PhotoRoomSelect
                        houseId={room.data.houseId}
                        onPick={(rid) => setPhotoRoom.mutate({ id: placePhotoId, roomId: rid })}
                        disabled={setPhotoRoom.isPending}
                      />
                    </div>
                  )}
                  {setPhotoRoom.isError && <span className="text-destructive">{setPhotoRoom.error.message}</span>}
                  <button className="ml-auto" title="Dismiss" onClick={dropPlacePhotoParam}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {/* Both views stay mounted - toggling via `hidden` instead of
                  conditional JSX - so switching tabs doesn't tear down and
                  recreate the 3D view's WebGL context every time (React
                  StrictMode double-invokes effects, so repeated mount/unmount
                  cycles can exhaust the browser's WebGL context limit). */}
              <div hidden={view !== "2d"} data-zoom-ignore="">
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
                  pinMode={pinMode || placing != null}
                  onPinPlace={onPlanClick}
                  cameras={cameraMarkers}
                  selectedCameraId={selectedCameraId}
                  onSelectCamera={selectCamera}
                  onCameraChange={(photoId, camera) => void writeCamera(photoId, camera)}
                  cameraMode={cameraPlacing != null}
                  onCameraPlace={placeCameraAt}
                  ghostWalls={diff?.before?.walls ?? null}
                  moves={scanMoves}
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
                  pinMode={pinMode || placing != null}
                  onPinPlace={onPlanClick}
                  cameras={cameras3d}
                  selectedCameraId={selectedCameraId}
                  onSelectCamera={(photoId) => {
                    selectCamera(photoId);
                    openCameraPhoto(photoId);
                  }}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {view === "2d"
                  ? "Drag to move · drag the blue circle to rotate (shift = free angle) · drag the corner square to resize. A photo's dot moves it, the handle at its view's tip aims it (shift = wider or narrower). The ⟲/⟳ buttons above only rotate the view, not the data."
                  : "Drag to orbit · scroll to zoom · click an item to select it, a photo's cone to open it."}
              </p>
              {room.data.items.some((it) => !it.pos && placeable(it)) && (
                <div className="mt-3">
                  <p className="micro-label text-muted-foreground">
                    To place · {room.data.items.filter((it) => !it.pos && placeable(it)).length}
                    {!roomSized && <span className="ml-1 text-amber-700 font-normal">size the room above first.</span>}
                  </p>
                  <ul className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {room.data.items
                      .filter((it) => !it.pos && placeable(it))
                      .map((it) => (
                        <li
                          key={it.id}
                          className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-border bg-white pl-2 pr-0.5"
                        >
                          <Link to={`/items/${it.id}`} className="min-w-0 flex-1 truncate text-[12px] text-foreground hover:underline" title={it.name}>
                            {it.name}
                          </Link>
                          {it.ownerRoomId === id ? (
                            // the title sits on a wrapper: a disabled Button has
                            // pointer-events: none, so its own title never shows
                            <span
                              className="inline-flex shrink-0"
                              title={
                                !roomSized
                                  ? sizeNotice
                                  : it.parentId != null
                                    ? insideTitle(it.parentId)
                                    : `Place ${it.name} on the plan`
                              }
                            >
                              <Button
                                size="sm"
                                variant={placing?.id === it.id ? "default" : "outline"}
                                className="h-6 px-1.5 text-[11px]"
                                disabled={!roomSized || it.parentId != null}
                                onClick={() =>
                                  placing?.id === it.id ? cancelPlace() : startPlace({ id: it.id, name: it.name })
                                }
                              >
                                <MapPin className="h-3 w-3 mr-0.5" /> Place
                              </Button>
                            </span>
                          ) : (
                            <Link
                              to={`/rooms/${it.ownerRoomId}?placeItem=${it.id}`}
                              className="shrink-0 truncate px-1 text-[11px] text-primary hover:underline"
                            >
                              in {it.ownerRoomName} →
                            </Link>
                          )}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {(scans.data?.length ?? 0) > 0 && (
                <div className="mt-4 text-[12px]">
                  <p className="text-muted-foreground">
                    Scans:
                    <span className="ml-1">select one to compare it with the Place before it.</span>
                  </p>
                  {undoNote && (
                    <div className="mt-1 flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900">
                      <span>{undoNote}</span>
                      <button className="ml-auto" title="Dismiss" onClick={() => setUndoNote(null)}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <ul className="mt-1 space-y-1.5">
                    {scans.data!.map((s) => {
                      const sel = selectedScanId === s.id;
                      const undone = s.revertedAt != null;
                      const c = s.counts;
                      const summary = [
                        c.moved ? `${c.moved} moved` : null,
                        c.created ? `${c.created} new` : null,
                        c.missing ? `${c.missing} not found` : null,
                        c.matched ? `${c.matched} same place` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <li
                          key={s.id}
                          className={`rounded border bg-white ${sel ? "border-orange-400" : "border-border"} ${undone ? "opacity-60" : ""}`}
                        >
                          <div className="flex items-center gap-2 p-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedScanId(sel ? null : s.id);
                                setConfirmUndoId(null);
                                revertScan.reset();
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              title={sel ? "Stop comparing" : "Compare with the Place before this scan"}
                            >
                              <ScanLine className={`h-3.5 w-3.5 shrink-0 ${sel ? "text-orange-600" : "text-muted-foreground"}`} />
                              <span className="min-w-0">
                                <span className={`block truncate ${undone ? "line-through text-muted-foreground" : "text-foreground"}`}>
                                  {scanWhen(s.scanDate)} · {SCAN_SOURCE[s.source] ?? s.source}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {undone ? `undone ${scanWhen(s.revertedAt!)}` : summary || "outline only"}
                                </span>
                              </span>
                            </button>
                            {s.id === latestLiveScanId && confirmUndoId !== s.id && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 shrink-0 px-1.5 text-[11px]"
                                onClick={() => {
                                  setConfirmUndoId(s.id);
                                  revertScan.reset();
                                }}
                              >
                                <Undo2 className="h-3 w-3 mr-0.5" /> Undo this scan
                              </Button>
                            )}
                          </div>
                          {confirmUndoId === s.id && (
                            <div className="border-t border-border bg-amber-50 px-2 py-1.5 text-amber-900">
                              <p>
                                The outline and the Things' places go back to before this scan; Things it found that
                                nobody has touched since are deleted.
                              </p>
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <Button
                                  size="sm"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={revertScan.isPending}
                                  onClick={() => revertScan.mutate({ scanId: s.id })}
                                >
                                  {revertScan.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                                  Undo
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-[11px]"
                                  disabled={revertScan.isPending}
                                  onClick={() => setConfirmUndoId(null)}
                                >
                                  Keep
                                </Button>
                                {revertScan.error && <span className="text-destructive">{revertScan.error.message}</span>}
                              </div>
                            </div>
                          )}
                          {sel && (
                            <div className="border-t border-border px-1.5 py-1.5">
                              {scanDiff.isLoading ? (
                                <span className="flex items-center gap-1 text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                                </span>
                              ) : scanDiff.error ? (
                                <span className="text-destructive">{scanDiff.error.message}</span>
                              ) : diff ? (
                                <>
                                  {diff.before && view === "2d" && (
                                    <p className="mb-1 px-1.5 text-[11px] text-muted-foreground">
                                      The dashed grey outline is the Place before this scan; orange arrows show where Things
                                      moved.
                                    </p>
                                  )}
                                  <ScanDiffList
                                    changes={diff.changes}
                                    firstScan={diff.before == null}
                                    selectedId={selectedId}
                                    onSelect={selectItem}
                                  />
                                </>
                              ) : null}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

            <aside className="mt-4 w-full max-w-md rounded-lg border border-border bg-white p-4">
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

                  <input
                    type="text"
                    placeholder="Room name"
                    className="mt-3 w-full h-8 rounded-md border border-border bg-white px-2 text-[13px]"
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
              ) : selectedCamera && !cameraPlacing ? (
                <CameraCard
                  title={photoTitle(selectedCamera)}
                  camera={selectedCamera.camera!}
                  storageKey={selectedCamera.storageKey}
                  busy={setCamera.isPending}
                  error={cameraError}
                  confirmRemove={confirmRemoveCamera}
                  onOpen={() => setZoomPhoto({ storageKey: selectedCamera.storageKey, title: photoTitle(selectedCamera) })}
                  onSuggest={() => void suggestForSelected()}
                  onRemove={async () => {
                    if (!confirmRemoveCamera) {
                      setConfirmRemoveCamera(true);
                      return;
                    }
                    if (await writeCamera(selectedCamera.photoId, null)) {
                      setSelectedCameraId(null);
                      setConfirmRemoveCamera(false);
                    }
                  }}
                  onClose={() => {
                    setSelectedCameraId(null);
                    setConfirmRemoveCamera(false);
                    setCameraError(null);
                  }}
                />
              ) : !selectedItem ? (
                <p className="text-[13px] text-muted-foreground">
                  {cutMode
                    ? "Drag a rectangle on the plan to mark the room's area."
                    : cameraPlacing
                      ? `Click the plan where ${cameraPlacing.title} was taken.`
                      : placing
                      ? `Click the plan where ${placing.name} stands.`
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

                  {selectedItem.ownerRoomId === room.data.id && selectedItem.pos && (
                    <div className="mt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[12px]"
                        disabled={snapToWall.isPending}
                        onClick={() => {
                          setSnapNote(null);
                          snapToWall.mutate({ id: selectedItem.id });
                        }}
                      >
                        Snap to wall
                      </Button>
                      {snapNote?.itemId === selectedItem.id && (
                        <p className={`mt-1 text-[11px] ${snapNote.error ? "text-destructive" : "text-emerald-700"}`}>{snapNote.text}</p>
                      )}
                    </div>
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
            <RoomPhotoPool roomId={id} title={room.data.name} houseId={room.data.houseId} />
          </div>
          <ZoomOverlay open={zoomPhoto != null} onClose={() => setZoomPhoto(null)} title={zoomPhoto?.title}>
            {zoomPhoto && <FullPhoto storageKey={zoomPhoto.storageKey} />}
          </ZoomOverlay>
        </>
      )}
    </div>
  );
}

/** The selected photo marker: what it shows, where it stands, and the
 * actions on it. Remove asks twice. */
function CameraCard(props: {
  title: string;
  camera: PhotoCamera;
  storageKey: string;
  busy: boolean;
  error: string | null;
  confirmRemove: boolean;
  onOpen: () => void;
  onSuggest: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { title, camera } = props;
  const url = trpc.photos.url.useQuery({ key: props.storageKey }).data?.url ?? null;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-[14px] break-words">{title}</p>
        <button type="button" title="Close" onClick={props.onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {url ? (
        <button type="button" className="mt-2 block w-full" title="Open" onClick={props.onOpen}>
          <img src={url} alt="" className="w-full max-h-40 rounded object-cover bg-muted" />
        </button>
      ) : (
        <div className="mt-2 h-24 w-full rounded bg-muted" />
      )}
      <p className="text-[12px] text-muted-foreground mt-2">
        at {camera.xM.toFixed(2)}, {camera.yM.toFixed(2)} m · facing {Math.round(camera.headingDeg)}° · view{" "}
        {Math.round(camera.fovDeg)}°
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={!url} onClick={props.onOpen}>
          <Maximize2 className="h-3.5 w-3.5 mr-1" /> Open
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={props.busy} onClick={props.onSuggest}>
          <Sparkles className="h-3.5 w-3.5 mr-1" /> Suggest from pins
        </Button>
      </div>
      {props.error && <p className="mt-2 text-[11px] text-destructive">{props.error}</p>}
      <div className="mt-3 border-t border-border pt-2">
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onRemove}
          className="text-[12px] text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
        >
          {props.confirmRemove ? "Really remove from the plan?" : "Remove from plan"}
        </button>
      </div>
    </>
  );
}

const photoTitle = (p: { photoId: number; title: string | null }) => p.title || `Photo #${p.photoId}`;

/** The full-size photo behind a marker, for the zoom overlay. */
function FullPhoto({ storageKey }: { storageKey: string }) {
  const url = trpc.photos.url.useQuery({ key: storageKey }).data?.url;
  if (!url) return null;
  return <img src={url} alt="" draggable={false} className="max-w-full max-h-full object-contain rounded" />;
}

/** Width x depth for a room without a plan; saving gives the room its 2D
 * plan (and a box in 3D), so Things can be placed on it. */
function RoomSizeForm({ roomId, widthM, depthM }: { roomId: number; widthM: number | null; depthM: number | null }) {
  const utils = trpc.useUtils();
  const [w, setW] = useState(widthM != null && widthM > 0 ? String(widthM) : "");
  const [d, setD] = useState(depthM != null && depthM > 0 ? String(depthM) : "");
  const update = trpc.rooms.update.useMutation({
    onSuccess: () => {
      void utils.rooms.get.invalidate({ id: roomId });
      void utils.rooms.list.invalidate();
      void utils.items.placement.invalidate();
    },
  });
  const wn = Number(w.replace(",", "."));
  const dn = Number(d.replace(",", "."));
  const ok = w !== "" && d !== "" && wn > 0 && dn > 0 && wn <= 100 && dn <= 100;
  return (
    <form
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) update.mutate({ id: roomId, widthM: wn, depthM: dn });
      }}
    >
      <input
        aria-label="Width in metres"
        inputMode="decimal"
        placeholder="Width"
        value={w}
        onChange={(e) => setW(e.target.value)}
        className="h-6 w-16 rounded border border-border bg-white px-1.5 text-[12px] text-foreground"
      />
      <span>×</span>
      <input
        aria-label="Depth in metres"
        inputMode="decimal"
        placeholder="Depth"
        value={d}
        onChange={(e) => setD(e.target.value)}
        className="h-6 w-16 rounded border border-border bg-white px-1.5 text-[12px] text-foreground"
      />
      <span>m ·</span>
      <Button type="submit" size="sm" className="h-6 px-2 text-[11px]" disabled={!ok || update.isPending}>
        {update.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
      </Button>
      {update.error && <span className="text-destructive">{update.error.message}</span>}
    </form>
  );
}
