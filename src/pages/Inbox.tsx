import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { CaptureBar } from "@/components/CaptureBar";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { AreaPicker } from "@/components/AreaPicker";
import { ItemPicker } from "@/components/ItemPicker";
import { RoomPicker } from "@/components/RoomPicker";
import { setLastRoomId } from "@/lib/lastRoom";
import { useLastRoomId } from "@/hooks/use-last-room";
import { AiProgressBar } from "@/components/AiProgressBar";
import { DetectObjectsModal } from "@/components/DetectObjects";
import { GeojsonThumb } from "@/components/GeojsonThumb";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { useZoomable } from "@/hooks/use-zoomable";
import { isGeojsonFile } from "@/lib/geojsonFloor";
import { PhotoPlaceDialog, type PlaceTarget } from "@/components/PhotoPlaceDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import {
  Sparkles,
  Check,
  X,
  Link2,
  StickyNote,
  Image as ImageIcon,
  File as FileIcon,
  Loader2,
  AlertTriangle,
  Columns2,
  AlertCircle,
  ScanSearch,
  Boxes,
  Mic,
  MapPin,
  Camera,
  Copy,
  Pencil,
  Home,
} from "lucide-react";
import type { Capture, TriageSuggestion } from "@db/schema";

type InboxCapture = Capture & {
  photoId: number | null;
  photoRoomId: number | null;
  roomName: string | null;
  houseId: number | null;
  hasCamera: boolean;
};

function placeTargetOf(c: InboxCapture): PlaceTarget {
  if (c.photoId != null) {
    return {
      source: "photo",
      photoId: c.photoId,
      roomId: c.photoRoomId,
      houseId: c.houseId,
      ofThing: false,
      hasCamera: c.hasCamera,
    };
  }
  return { source: "capture", captureId: c.id };
}

/** Set or move the Photo's Place without leaving Inbox. */
function CapturePlaceButton({
  capture,
  onPick,
  compact = false,
}: {
  capture: InboxCapture;
  onPick: (c: InboxCapture) => void;
  compact?: boolean;
}) {
  if (capture.kind !== "image" || !capture.storageKey) return null;
  const placed = capture.photoRoomId != null;
  const label = placed ? (capture.roomName ?? "Place") : "Set Place";
  if (compact) {
    return (
      <button
        type="button"
        className="mt-1 flex w-full items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
        title={placed ? `Move from ${label}` : "Give this Photo a Place"}
        onClick={(e) => {
          e.stopPropagation();
          onPick(capture);
        }}
      >
        <Home className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-6 text-[11px]"
      title={placed ? `Move from ${label}` : "Give this Photo a Place"}
      onClick={(e) => {
        e.stopPropagation();
        onPick(capture);
      }}
    >
      <Home className="h-3 w-3 mr-1" />
      {label}
    </Button>
  );
}

const KIND_ICONS = {
  note: StickyNote,
  link: Link2,
  image: ImageIcon,
  file: FileIcon,
  scan: Boxes,
  voice: Mic,
};

/** Thumbnail for a processed capture; falls back to its kind icon. Fills its
 * grid cell (catalog style) rather than being a fixed small square. */
function ProcessedThumb({ storageKey, kind }: { storageKey: string | null; kind: keyof typeof KIND_ICONS }) {
  const Icon = KIND_ICONS[kind];
  const url = trpc.photos.url.useQuery({ key: storageKey ?? "" }, { enabled: !!storageKey && kind === "image" });
  if (kind === "image" && url.data?.url) {
    return (
      <div className="aspect-square w-full overflow-hidden rounded-md border border-border bg-muted/40">
        <img src={url.data.url} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  if ((kind === "scan" || isGeojsonFile(storageKey)) && storageKey) {
    return <GeojsonThumb storageKey={storageKey} />;
  }
  return (
    <div className="aspect-square w-full flex items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
      <Icon className="h-5 w-5" />
    </div>
  );
}

/** Jump from a photo straight into the pin-objects canvas - same
 * find-or-create-attachment step the Map view uses, just entered from here.
 * A labeled button, not just an icon - an icon-only version of this was easy
 * to miss next to the rest of a processed row's clutter. */
function PinCaptureButton({
  captureId,
  roomId = null,
  className = "shrink-0",
  iconOnly = false,
}: {
  captureId: number;
  roomId?: number | null;
  className?: string;
  iconOnly?: boolean;
}) {
  const navigate = useNavigate();
  const ensure = trpc.photos.ensureForCapture.useMutation({
    onSuccess: (res) => navigate(`/annotate/${res.photoId}`),
  });
  if (iconOnly) {
    return (
      <button
        className="absolute bottom-1.5 right-1.5 h-6 w-6 rounded-full bg-white/90 shadow flex items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-50"
        title="Pin objects on this photo"
        disabled={ensure.isPending}
        onClick={(e) => {
          e.stopPropagation();
          ensure.mutate({ captureId, roomId });
        }}
      >
        {ensure.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MapPin className="h-3.5 w-3.5" />
        )}
      </button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-6 text-[11px]", className)}
      title="Pin objects on this photo"
      disabled={ensure.isPending}
      onClick={(e) => {
        e.stopPropagation();
        ensure.mutate({ captureId, roomId });
      }}
    >
      {ensure.isPending ? (
        <Loader2 className="h-3 w-3 animate-spin mr-1" />
      ) : (
        <MapPin className="h-3 w-3 mr-1" />
      )}
      Pin
    </Button>
  );
}

/** Phone-first: opens the camera directly (capture="environment" skips the
 * gallery/file picker most browsers show for a plain file input) for the
 * walk-the-building capture flow that used to be the standalone Snap page. */
function MobileCameraButton() {
  const utils = trpc.useUtils();
  const photoRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const create = trpc.inbox.create.useMutation({
    onSuccess: () => utils.inbox.list.invalidate(),
  });
  return (
    <div className="md:hidden">
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const up = await uploadFile(f, "inbox");
            create.mutate({
              kind: "image",
              fileName: up.fileName || `snap-${Date.now()}.jpg`,
              storageKey: up.key,
              mimeType: up.mimeType,
            });
          } catch (err) {
            setUploadError((err as Error).message);
          }
        }}
      />
      <button
        onClick={() => photoRef.current?.click()}
        disabled={create.isPending}
        className="w-full rounded-xl bg-[#282c20] text-[#f4f4ed] py-5 flex items-center justify-center gap-2 active:bg-[#3a3f2e] transition-colors"
      >
        {create.isPending ? (
          <Loader2 className="h-5 w-5 animate-spin text-[#d2ff00]" />
        ) : (
          <Camera className="h-5 w-5 text-[#d2ff00]" />
        )}
        <span className="text-[14px] font-semibold">Take photo</span>
      </button>
      {uploadError && <div className="mt-2 text-[12px] text-destructive">{uploadError}</div>}
    </div>
  );
}

type CompareSide = {
  label: string;
  suggestion: import("@db/schema").TriageSuggestion | null;
  error: string | null;
  ms: number;
};
type CompareResult = { a: CompareSide; b: CompareSide };

/** A floor-scan outline in a triage card: double-click (or ⤢) opens it
 * large in the pan/zoom overlay. */
function ZoomableGeojson({ storageKey }: { storageKey: string }) {
  const zoom = useZoomable();
  return (
    <div className="relative w-28 shrink-0 cursor-zoom-in" {...zoom.props}>
      <GeojsonThumb storageKey={storageKey} />
      <button
        type="button"
        onClick={zoom.show}
        className="absolute top-1 right-1 h-5 w-5 flex items-center justify-center rounded bg-white/80 text-[12px] leading-none text-muted-foreground hover:text-foreground"
        title="Enlarge"
        aria-label="Enlarge"
      >
        ⤢
      </button>
      <ZoomOverlay open={zoom.open} onClose={zoom.close} title="Floor scan">
        <div className="w-[min(90vw,calc(100dvh-6rem))] bg-white rounded-lg">
          <GeojsonThumb storageKey={storageKey} />
        </div>
      </ZoomOverlay>
    </div>
  );
}

function CaptureImage({ storageKey }: { storageKey: string }) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  if (!url.data?.url) return null;
  return (
    <img
      src={url.data.url}
      alt=""
      className="h-56 w-56 object-cover rounded-lg border border-border"
    />
  );
}

/** Before a pending (untriaged) photo goes into the pin canvas, confirm
 * where it was taken - unlike an already-filed item, nothing here carries a
 * location yet, and that confirmation rides along in the URL so a new item
 * created while pinning starts out placed instead of homeless. */
function PinPendingButton({ captureId }: { captureId: number }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const lastRoomId = useLastRoomId();
  const [roomId, setRoomIdRaw] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  if (!touched && roomId == null && lastRoomId != null) setRoomIdRaw(lastRoomId);
  const setRoomId = (id: number | null) => {
    setTouched(true);
    setRoomIdRaw(id);
  };
  const rooms = trpc.rooms.list.useQuery();
  const roomName = rooms.data?.find((r) => r.id === roomId)?.name ?? "unset";
  const hasDefaultLocation = roomId != null;
  const ensure = trpc.photos.ensureForCapture.useMutation({
    onSuccess: (res) => {
      setLastRoomId(roomId);
      navigate(`/annotate/${res.photoId}?roomId=${roomId ?? "none"}`);
    },
  });

  return (
    <>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[11px]"
          disabled={ensure.isPending}
          onClick={(e) => {
            e.stopPropagation();
            // already have a working default (set here before, or anywhere
            // else that's confirmed one) - pinning again shouldn't re-ask
            // the same question every single time
            if (hasDefaultLocation) ensure.mutate({ captureId, roomId });
            else setOpen(true);
          }}
        >
          {ensure.isPending ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <MapPin className="h-3 w-3 mr-1" />
          )}
          Pin
        </Button>
        {hasDefaultLocation && (
          <button
            className="text-muted-foreground hover:text-foreground"
            title={`Change location (currently ${roomName})`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Where was this taken?</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-2">
            Confirms the location before pinning - a new item created there starts out placed.
          </p>
          <RoomPicker value={roomId} onChange={setRoomId} />
          <div className="flex justify-end gap-2 mt-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={ensure.isPending}
              onClick={() => ensure.mutate({ captureId, roomId })}
            >
              {ensure.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <MapPin className="h-3.5 w-3.5 mr-1" />
              )}
              Continue to pin
            </Button>
          </div>
          {ensure.isError && <div className="text-[12px] text-destructive">{ensure.error.message}</div>}
        </DialogContent>
      </Dialog>
    </>
  );
}

type TriageRow = {
  itemName: string;
  /** the AI's own visual description, kept around so a matched row still
   * shows what it actually saw - handy for judging whether a match is
   * really right ("Black board... screw terminals" matched to "ITHO RF
   * ESPHome" is a very different thing from a Volumio Pi, say) */
  aiDescription: string;
  matchedId: number | null;
  matchedName: string | null;
  areaId: number | null;
  attributes?: Record<string, string>;
};

function buildTriageRows(s: TriageSuggestion, areasData: { id: number; slug: string }[] | undefined): TriageRow[] {
  // older captures triaged before this became a list still have the old
  // single-item shape persisted (no items array) - treat that as "nothing
  // usable yet" rather than crash; re-running AI triage replaces it anyway
  if (!Array.isArray(s.items)) return [];
  return s.items.map((it) => ({
    itemName: it.matchedItemName ?? it.itemName,
    aiDescription: it.itemName,
    matchedId: it.matchedItemId ?? null,
    matchedName: it.matchedItemName ?? null,
    areaId: areasData?.find((a) => a.slug === it.areaSlug)?.id ?? areasData?.[0]?.id ?? null,
    attributes: it.attributes,
  }));
}

/** One spotted object - search/pick an existing item or type a new name
 * (same ItemPicker everywhere else in the app uses), topic only matters
 * once it's heading toward becoming a new item. */
function TriageSpottedRow({
  row,
  onChange,
  onRemove,
}: {
  row: TriageRow;
  onChange: (next: Partial<TriageRow>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-white p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <ItemPicker
            placeholder="Search or name this object…"
            value={row.itemName}
            onQueryChange={(v) => onChange({ itemName: v, matchedId: null, matchedName: null })}
            onSelect={(item) => onChange({ itemName: item.name, matchedId: item.id, matchedName: item.name })}
            allowCreate
            onCreateNew={(name) => onChange({ itemName: name, matchedId: null, matchedName: null })}
          />
        </div>
        <button
          className="text-muted-foreground hover:text-destructive shrink-0"
          title="Remove from list"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {row.matchedId ? (
        <>
          <div className="flex items-center gap-1 text-[11px] text-emerald-700">
            <Check className="h-3 w-3 shrink-0" /> already have this{row.matchedName ? ` — ${row.matchedName}` : ""}
            <button
              className="ml-1 text-emerald-700/70 hover:text-destructive"
              title="Not the same object - unlink and search again or create new"
              onClick={() => onChange({ itemName: row.aiDescription, matchedId: null, matchedName: null })}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {row.aiDescription !== row.matchedName && (
            <div className="text-[11px] text-muted-foreground">AI saw: {row.aiDescription}</div>
          )}
        </>
      ) : (
        <AreaPicker value={row.areaId} onChange={(id) => onChange({ areaId: id })} />
      )}
      {row.attributes && Object.keys(row.attributes).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(row.attributes).map(([k, v]) => (
            <span key={k} className="font-data text-[10px] rounded bg-muted px-1 py-0.5">
              {k}: {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TriageCard({
  capture,
  onZoom,
  onPlace,
}: {
  capture: InboxCapture;
  onZoom: (storageKey: string, captureId: number, isPending: boolean) => void;
  onPlace: (c: InboxCapture) => void;
}) {
  const utils = trpc.useUtils();
  const s = capture.suggestion;
  // older captures triaged before suggestions became a list still have the
  // old single-item shape persisted - treat that the same as "not triaged
  // yet" rather than show a broken, permanently-empty panel for it
  const hasSuggestion = !!s && Array.isArray(s.items);
  const areas = trpc.areas.list.useQuery();

  const [rows, setRows] = useState<TriageRow[]>(() => (s ? buildTriageRows(s, areas.data) : []));
  const lastRoomId = useLastRoomId();
  // a suggested room id is only usable if it is one of the session house's rooms
  const houseRooms = trpc.rooms.list.useQuery();
  const inHouse = (id: number | null | undefined): id is number =>
    id != null && !!houseRooms.data?.some((r) => r.id === id);
  const [roomIdRaw, setRoomIdRaw] = useState<number | null>(null);
  const [roomTouched, setRoomTouched] = useState(false);
  const roomId = roomTouched ? roomIdRaw : (roomIdRaw ?? (inHouse(s?.roomId) ? s.roomId : null) ?? lastRoomId ?? null);
  const setRoomId = (id: number | null) => {
    setRoomTouched(true);
    setRoomIdRaw(id);
  };
  const [aiError, setAiError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [detectOpen, setDetectOpen] = useState(false);
  const [geoRoomId, setGeoRoomId] = useState<number | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  const triage = trpc.inbox.triage.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        utils.inbox.list.invalidate();
        setRows(buildTriageRows(res.suggestion, areas.data));
        if (inHouse(res.suggestion.roomId)) setRoomId(res.suggestion.roomId);
      } else setAiError(res.error);
    },
    onError: (e) => setAiError(e.message),
  });
  const acceptMany = trpc.inbox.acceptMany.useMutation({
    onSuccess: () => {
      utils.inbox.list.invalidate();
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
    },
  });
  const dismiss = trpc.inbox.dismiss.useMutation({
    onSuccess: () => utils.inbox.list.invalidate(),
  });
  const importGeojson = trpc.inbox.importGeojson.useMutation({
    onSuccess: () => {
      setGeoError(null);
      utils.inbox.list.invalidate();
      utils.rooms.list.invalidate();
      utils.rooms.get.invalidate();
      utils.rooms.scans.invalidate();
    },
    onError: (e) => setGeoError(e.message),
  });
  const compare = trpc.inbox.compare.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setAiError(null);
        setCompareResult({ a: res.a, b: res.b });
      } else setAiError(res.error);
    },
    onError: (e) => setAiError(e.message),
  });

  const updateRow = (i: number, patch: Partial<TriageRow>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const canFile =
    rows.length > 0 && rows.every((r) => r.matchedId != null || (r.areaId != null && r.itemName.trim()));
  const newCount = rows.filter((r) => r.matchedId == null).length;

  const KindIcon = KIND_ICONS[capture.kind];

  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <div className="flex items-start gap-3">
        <KindIcon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          {(capture.url || capture.rawText || capture.kind !== "image") && (
            <div className="text-[13px] whitespace-pre-wrap break-words">
              {capture.url ? (
                <a href={capture.url} target="_blank" rel="noreferrer" className="text-primary underline">
                  {capture.url}
                </a>
              ) : (
                capture.rawText || (isGeojsonFile(capture.storageKey) ? "GeoJSON floor scan" : "(file)")
              )}
            </div>
          )}
          {capture.storageKey && (capture.kind === "scan" || isGeojsonFile(capture.storageKey)) && (
            <div className="mt-2 flex items-start gap-3">
              <ZoomableGeojson storageKey={capture.storageKey} />
              <div className="flex flex-col gap-1.5 flex-1 max-w-xs">
                <RoomPicker value={geoRoomId} onChange={setGeoRoomId} />
                <div className="text-[11px] text-muted-foreground">
                  Pick the room this scan belongs to, or type a new name
                </div>
                <Button
                  size="sm"
                  className="h-7 text-[12px] w-fit"
                  disabled={geoRoomId == null || importGeojson.isPending}
                  onClick={() => importGeojson.mutate({ captureId: capture.id, roomId: geoRoomId! })}
                >
                  {importGeojson.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                  Import floor
                </Button>
                {geoError && <div className="text-[11px] text-destructive">{geoError}</div>}
              </div>
            </div>
          )}
          {capture.storageKey && capture.kind === "image" && (
            <div className="mt-2 flex items-start gap-3">
              <button
                title="Click to enlarge"
                className="cursor-zoom-in"
                onClick={() => onZoom(capture.storageKey!, capture.id, true)}
              >
                <CaptureImage storageKey={capture.storageKey} />
              </button>
              <div className="flex flex-col gap-1.5 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px]"
                  onClick={() => setDetectOpen(true)}
                >
                  <ScanSearch className="h-3 w-3 mr-1" /> detect objects
                </Button>
                <CapturePlaceButton capture={capture} onPick={onPlace} />
                <PinPendingButton captureId={capture.id} />
              </div>
            </div>
          )}
          <div className="font-data text-[11px] text-muted-foreground mt-1">
            {capture.kind} · {timeAgo(capture.createdAt)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
        <div className="flex gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[12px]"
            title="Run the same triage on Provider A and Provider B, side by side"
            disabled={compare.isPending}
            onClick={() => {
              setAiError(null);
              compare.mutate({ id: capture.id });
            }}
          >
            {compare.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Columns2 className="h-3.5 w-3.5 mr-1" />
            )}
            A/B
          </Button>
          {!hasSuggestion && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[12px]"
              disabled={triage.isPending}
              onClick={() => {
                setAiError(null);
                triage.mutate({ id: capture.id });
              }}
            >
              {triage.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              AI triage
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground"
            title="Dismiss"
            onClick={() => dismiss.mutate({ id: capture.id })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
          <AiProgressBar active={compare.isPending} action="inbox.compare" />
          <AiProgressBar active={triage.isPending} action="inbox.triage" />
        </div>
      </div>

      {aiError && (
        <div className="mt-3 flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {aiError}
        </div>
      )}

      <DetectObjectsModal
        captureId={capture.id}
        open={detectOpen}
        onClose={() => setDetectOpen(false)}
      />

      <CompareModal
        result={compareResult}
        onClose={() => setCompareResult(null)}
        onUse={(side) => {
          if (!side.suggestion) return;
          setRows(buildTriageRows(side.suggestion, areas.data));
          if (inHouse(side.suggestion.roomId)) setRoomId(side.suggestion.roomId);
          setCompareResult(null);
        }}
      />

      {hasSuggestion && (
        <div className="mt-3 rounded-md border border-violet-200 bg-violet-50/60 p-3">
          <div className="micro-label text-violet-700 mb-2">
            AI suggestion · {rows.length} item{rows.length === 1 ? "" : "s"} spotted
          </div>
          {s.note && <p className="text-[12px] text-violet-900 mb-2">{s.note}</p>}

          <div className="space-y-1.5">
            {rows.map((row, i) => (
              <TriageSpottedRow
                key={i}
                row={row}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeRow(i)}
              />
            ))}
            {rows.length === 0 && (
              <div className="text-[12px] text-muted-foreground">Nothing left to file.</div>
            )}
          </div>

          <label className="block mt-2">
            <span className="micro-label text-muted-foreground">Location (applies to every new item above)</span>
            <div className="mt-0.5">
              <RoomPicker value={roomId} onChange={setRoomId} allowNone />
            </div>
          </label>

          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              className="h-7 text-[12px]"
              disabled={acceptMany.isPending || !canFile}
              onClick={() => {
                setLastRoomId(roomId);
                acceptMany.mutate({
                  id: capture.id,
                  roomId,
                  items: rows.map((r) => ({
                    areaId: r.areaId ?? 0,
                    itemId: r.matchedId,
                    itemName: r.itemName || "Untitled",
                    attributes: r.attributes,
                  })),
                });
              }}
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              {acceptMany.isPending
                ? "Filing…"
                : newCount > 0
                  ? `File ${newCount} new item${newCount === 1 ? "" : "s"}`
                  : "Confirm"}
            </Button>
          </div>
          {acceptMany.error && (
            <div className="mt-2 flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {acceptMany.error.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CompareModal({
  result,
  onClose,
  onUse,
}: {
  result: CompareResult | null;
  onClose: () => void;
  onUse: (side: CompareSide) => void;
}) {
  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Provider A vs Provider B — same prompt, both models</DialogTitle>
        </DialogHeader>
        {result && (
          <div className="grid sm:grid-cols-2 gap-3">
            {[result.a, result.b].map((side) => (
              <div
                key={side.label}
                className="rounded-lg border border-border bg-white p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <span className="micro-label text-muted-foreground">{side.label}</span>
                  {side.suggestion && (
                    <span className="ml-auto font-data text-[10px] text-muted-foreground">
                      {side.suggestion.items.length} item{side.suggestion.items.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>

                {side.error ? (
                  <div className="flex gap-2 items-start rounded bg-red-50 border border-red-200 px-2 py-1.5 text-[12px] text-red-800">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-words">{side.error}</span>
                  </div>
                ) : side.suggestion ? (
                  <>
                    {side.suggestion.note && <div className="text-[12px] text-muted-foreground">{side.suggestion.note}</div>}
                    {side.suggestion.roomId == null && side.suggestion.room && (
                      <div className="font-data text-[11px] text-muted-foreground">
                        unknown room "{side.suggestion.room}"
                      </div>
                    )}
                    <div className="space-y-1">
                      {side.suggestion.items.map((it, i) => (
                        <div key={i} className="rounded border border-border bg-muted/30 px-2 py-1 text-[12px]">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{it.itemName}</span>
                            <span className="ml-auto micro-label text-muted-foreground">{it.areaSlug}</span>
                          </div>
                          {it.matchedItemId ? (
                            <div className="text-[11px] text-emerald-700">existing — {it.matchedItemName ?? `#${it.matchedItemId}`}</div>
                          ) : (
                            <div className="text-[11px] text-muted-foreground">new</div>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      className="h-7 text-[12px] w-full"
                      onClick={() => onUse(side)}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Use this result
                    </Button>
                  </>
                ) : (
                  <div className="text-[12px] text-muted-foreground">No result.</div>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function InboxPage() {
  const captures = trpc.inbox.list.useQuery();
  const [placeTarget, setPlaceTarget] = useState<PlaceTarget | null>(null);
  const [placeNote, setPlaceNote] = useState<string | null>(null);
  useEffect(() => {
    if (!placeNote) return;
    const t = setTimeout(() => setPlaceNote(null), 4000);
    return () => clearTimeout(t);
  }, [placeNote]);
  const pending = (captures.data ?? []).filter((c) => c.status === "pending");
  // dismissed means gone - showing it anyway (just greyed out) defeats the
  // point of dismissing something, so Processed only shows statuses someone
  // might still want to look back on
  const done = (captures.data ?? []).filter((c) => c.status !== "pending" && c.status !== "dismissed");
  const [lightbox, setLightbox] = useState<{ storageKey: string; captureId: number; isPending: boolean } | null>(
    null,
  );
  const lightboxUrl = trpc.photos.url.useQuery(
    { key: lightbox?.storageKey ?? "" },
    { enabled: !!lightbox },
  );
  const openLightbox = (storageKey: string, captureId: number, isPending: boolean) =>
    setLightbox({ storageKey, captureId, isPending });

  const utils = trpc.useUtils();
  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const mergeDuplicates = trpc.inbox.mergeDuplicates.useMutation({
    onSuccess: (res) => {
      utils.inbox.list.invalidate();
      setMergeResult(
        res.merged === 0 && res.skipped === 0
          ? "No duplicates found"
          : [
              res.merged > 0 ? `Merged ${res.merged} duplicate${res.merged === 1 ? "" : "s"}` : null,
              res.skipped > 0 ? `dismissed ${res.skipped} more already pinned elsewhere` : null,
            ]
              .filter(Boolean)
              .join(", "),
      );
    },
  });

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Drop anything here. AI triage proposes where it belongs — you confirm, it files.
      </p>

      <div className="mt-5 space-y-3">
        <MobileCameraButton />
        <CaptureBar />
      </div>

      <h2 className="micro-label text-muted-foreground mt-8 mb-2">
        Pending ({pending.length})
      </h2>
      <div className="space-y-3">
        {pending.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            Inbox zero. Nice.
          </div>
        )}
        {pending.map((c) => (
          <TriageCard key={c.id} capture={c} onZoom={openLightbox} onPlace={(cap) => setPlaceTarget(placeTargetOf(cap))} />
        ))}
      </div>

      {done.length > 0 && (
        <>
          <div className="flex items-center justify-between mt-8 mb-2">
            <h2 className="micro-label text-muted-foreground">Processed</h2>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px]"
              disabled={mergeDuplicates.isPending}
              onClick={() => {
                setMergeResult(null);
                mergeDuplicates.mutate();
              }}
            >
              {mergeDuplicates.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Copy className="h-3 w-3 mr-1" />
              )}
              Merge duplicates
            </Button>
          </div>

          {mergeResult && (
            <div className="mb-4 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              {mergeResult}
              <button className="text-amber-700 hover:text-amber-900" onClick={() => setMergeResult(null)}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {done.slice(0, 24).map((c) => (
              <div key={c.id} className="rounded-lg border border-border bg-white p-1.5">
                <div className="relative">
                  {c.kind === "image" && c.storageKey ? (
                    <button
                      className="cursor-zoom-in block w-full"
                      title="Click to enlarge"
                      onClick={() => openLightbox(c.storageKey!, c.id, false)}
                    >
                      <ProcessedThumb storageKey={c.storageKey} kind={c.kind} />
                    </button>
                  ) : (
                    <ProcessedThumb storageKey={c.storageKey} kind={c.kind} />
                  )}
                  {c.kind === "image" && c.storageKey && <PinCaptureButton captureId={c.id} iconOnly />}
                </div>
                <CapturePlaceButton capture={c} onPick={(cap) => setPlaceTarget(placeTargetOf(cap))} compact />
                <div className="mt-1 text-[10px] text-muted-foreground truncate">
                  {c.status} · {timeAgo(c.createdAt)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <ZoomOverlay
        open={!!lightbox}
        onClose={() => setLightbox(null)}
        toolbarExtra={
          lightbox && (
            <div className="flex items-center gap-1">
              {(() => {
                const cap = (captures.data ?? []).find((c) => c.id === lightbox.captureId);
                return cap ? <CapturePlaceButton capture={cap} onPick={(c) => setPlaceTarget(placeTargetOf(c))} /> : null;
              })()}
              {lightbox.isPending ? (
                <PinPendingButton captureId={lightbox.captureId} />
              ) : (
                <PinCaptureButton captureId={lightbox.captureId} />
              )}
            </div>
          )
        }
      >
        {lightboxUrl.data?.url && (
          <img src={lightboxUrl.data.url} alt="" draggable={false} className="max-w-full max-h-full object-contain rounded" />
        )}
      </ZoomOverlay>
      <PhotoPlaceDialog
        target={placeTarget}
        onClose={() => setPlaceTarget(null)}
        onMoved={(res) => setPlaceNote(res.roomName ? `Place: ${res.roomName}` : "Place cleared.")}
      />
      {placeNote && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-white px-3 py-1.5 text-[12px] shadow">
          {placeNote}
        </div>
      )}
    </div>
  );
}
