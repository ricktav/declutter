import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { CaptureBar } from "@/components/CaptureBar";
import { fileToBase64 } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AreaPicker } from "@/components/AreaPicker";
import { RoomPicker, type RoomValue } from "@/components/RoomPicker";
import { DetectObjectsModal } from "@/components/DetectObjects";
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
} from "lucide-react";
import type { Capture } from "@db/schema";

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
  const url = trpc.attachments.url.useQuery({ key: storageKey ?? "" }, { enabled: !!storageKey && kind === "image" });
  if (kind === "image" && url.data?.url) {
    return (
      <div className="aspect-square w-full overflow-hidden rounded-md border border-border bg-muted/40">
        <img src={url.data.url} alt="" className="h-full w-full object-cover" />
      </div>
    );
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
  houseId = null,
  className = "shrink-0",
  iconOnly = false,
}: {
  captureId: number;
  houseId?: number | null;
  className?: string;
  iconOnly?: boolean;
}) {
  const navigate = useNavigate();
  const ensure = trpc.map.ensureAttachmentForCapture.useMutation({
    onSuccess: (res) => navigate(`/annotate/${res.attachmentId}`),
  });
  if (iconOnly) {
    return (
      <button
        className="absolute bottom-1.5 right-1.5 h-6 w-6 rounded-full bg-white/90 shadow flex items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-50"
        title="Pin objects on this photo"
        disabled={ensure.isPending}
        onClick={(e) => {
          e.stopPropagation();
          ensure.mutate({ captureId, houseId });
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
        ensure.mutate({ captureId, houseId });
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
          const contentBase64 = await fileToBase64(f);
          create.mutate({
            kind: "image",
            fileName: f.name || `snap-${Date.now()}.jpg`,
            contentBase64,
            mimeType: f.type || "image/jpeg",
          });
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

function CaptureImage({ storageKey }: { storageKey: string }) {
  const url = trpc.attachments.url.useQuery({ key: storageKey });
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
  const [loc, setLoc] = useState<RoomValue>({ houseId: null, floor: "", room: "" });
  const ensure = trpc.map.ensureAttachmentForCapture.useMutation({
    onSuccess: (res) => {
      const params = new URLSearchParams({
        houseId: loc.houseId != null ? String(loc.houseId) : "none",
        floor: loc.floor.trim() || "none",
        room: loc.room.trim() || "none",
      });
      navigate(`/annotate/${res.attachmentId}?${params.toString()}`);
    },
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[11px]"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <MapPin className="h-3 w-3 mr-1" /> Pin
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Where was this taken?</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-2">
            Confirms the location before pinning - a new item created there starts out placed.
          </p>
          <RoomPicker value={loc} onChange={setLoc} />
          <div className="flex justify-end gap-2 mt-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={ensure.isPending}
              onClick={() =>
                ensure.mutate({
                  captureId,
                  houseId: loc.houseId,
                  floor: loc.floor.trim() || null,
                  room: loc.room.trim() || null,
                })
              }
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

function TriageCard({ capture, onZoom }: { capture: Capture; onZoom: (storageKey: string) => void }) {
  const utils = trpc.useUtils();
  const s = capture.suggestion;
  const areas = trpc.areas.list.useQuery();

  const [areaId, setAreaId] = useState<number | null>(null);
  const [itemName, setItemName] = useState<string | null>(null);
  const [matchMode, setMatchMode] = useState<"new" | "existing" | null>(null);
  const [matchedId, setMatchedId] = useState<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [detectOpen, setDetectOpen] = useState(false);

  const triage = trpc.inbox.triage.useMutation({
    onSuccess: (res) => {
      if (res.ok) utils.inbox.list.invalidate();
      else setAiError(res.error);
    },
    onError: (e) => setAiError(e.message),
  });
  const accept = trpc.inbox.accept.useMutation({
    onSuccess: () => {
      utils.inbox.list.invalidate();
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
    },
  });
  const dismiss = trpc.inbox.dismiss.useMutation({
    onSuccess: () => utils.inbox.list.invalidate(),
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

  // resolve effective selections (user override beats suggestion)
  const suggestedArea = areas.data?.find((a) => a.slug === s?.areaSlug);
  const effAreaId = areaId ?? suggestedArea?.id ?? areas.data?.[0]?.id;
  const effItemName = itemName ?? s?.itemName ?? "";
  const effMode = matchMode ?? (s?.matchedItemId ? "existing" : "new");
  const itemsInArea = trpc.items.listByArea.useQuery(
    { areaId: effAreaId ?? 0, includeArchived: false },
    { enabled: !!effAreaId },
  );
  const effMatchedId = matchedId ?? s?.matchedItemId ?? null;

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
                capture.rawText || "(file)"
              )}
            </div>
          )}
          {capture.storageKey && capture.kind === "image" && (
            <div className="mt-2 flex items-start gap-3">
              <button title="Click to view full size" className="cursor-zoom-in" onClick={() => onZoom(capture.storageKey!)}>
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
                <PinPendingButton captureId={capture.id} />
              </div>
            </div>
          )}
          <div className="font-data text-[11px] text-muted-foreground mt-1">
            {capture.kind} · {timeAgo(capture.createdAt)}
          </div>
        </div>
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
          {!s && (
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
          const sg = side.suggestion;
          const area = areas.data?.find((a) => a.slug === sg.areaSlug);
          if (area) setAreaId(area.id);
          setItemName(sg.itemName ?? null);
          if (sg.matchedItemId) {
            setMatchMode("existing");
            setMatchedId(sg.matchedItemId);
          } else {
            setMatchMode("new");
            setMatchedId(null);
          }
          setCompareResult(null);
        }}
      />

      {s && (
        <div className="mt-3 rounded-md border border-violet-200 bg-violet-50/60 p-3">
          <div className="micro-label text-violet-700 mb-2">
            AI suggestion · {s.confidence ?? "?"} confidence
          </div>
          {s.note && <p className="text-[12px] text-violet-900 mb-2">{s.note}</p>}
          <div className="grid sm:grid-cols-3 gap-2">
            <label className="block">
              <span className="micro-label text-muted-foreground">Area</span>
              <div className="mt-0.5">
                <AreaPicker value={effAreaId ?? null} onChange={setAreaId} />
              </div>
            </label>
            <label className="block sm:col-span-2">
              <span className="micro-label text-muted-foreground">Item</span>
              <div className="mt-0.5 flex gap-2">
                <select
                  className="rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
                  value={effMode}
                  onChange={(e) => setMatchMode(e.target.value as "new" | "existing")}
                >
                  <option value="new">new item</option>
                  <option value="existing">existing item</option>
                </select>
                {effMode === "new" ? (
                  <input
                    className="flex-1 rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
                    value={effItemName}
                    onChange={(e) => setItemName(e.target.value)}
                  />
                ) : (
                  <select
                    className="flex-1 rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
                    value={effMatchedId ?? ""}
                    onChange={(e) => setMatchedId(Number(e.target.value))}
                  >
                    <option value="" disabled>
                      pick item…
                    </option>
                    {(itemsInArea.data ?? []).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </label>
          </div>
          {s.attributes && Object.keys(s.attributes).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(s.attributes).map(([k, v]) => (
                <span key={k} className="font-data text-[11px] rounded bg-white border border-border px-1.5 py-0.5">
                  {k}: {v}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              className="h-7 text-[12px]"
              disabled={accept.isPending || !effAreaId || (effMode === "new" ? !effItemName : !effMatchedId)}
              onClick={() =>
                accept.mutate({
                  id: capture.id,
                  areaId: effAreaId!,
                  itemId: effMode === "existing" ? effMatchedId : null,
                  itemName: effItemName || "Untitled",
                  attributes: s.attributes,
                })
              }
            >
              <Check className="h-3.5 w-3.5 mr-1" /> Accept
            </Button>
          </div>
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
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        side.suggestion.confidence === "high"
                          ? "bg-emerald-100 text-emerald-800"
                          : side.suggestion.confidence === "medium"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-red-100 text-red-800"
                      }`}
                    >
                      {side.suggestion.confidence}
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
                    <div>
                      <div className="micro-label text-muted-foreground">Area</div>
                      <div className="text-[13px] font-medium">{side.suggestion.areaSlug}</div>
                    </div>
                    <div>
                      <div className="micro-label text-muted-foreground">Item</div>
                      <div className="text-[13px] font-medium">
                        {side.suggestion.itemName}
                        {side.suggestion.matchedItemId && (
                          <span className="ml-1 text-[11px] text-muted-foreground font-data">
                            (existing #{side.suggestion.matchedItemId})
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="micro-label text-muted-foreground">Note</div>
                      <div className="text-[12px]">{side.suggestion.note}</div>
                    </div>
                    {Object.keys(side.suggestion.attributes ?? {}).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(side.suggestion.attributes ?? {}).map(([k, v]) => (
                          <span
                            key={k}
                            className="font-data text-[11px] rounded bg-accent px-1.5 py-0.5"
                          >
                            {k}: {v}
                          </span>
                        ))}
                      </div>
                    )}
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
  const pending = (captures.data ?? []).filter((c) => c.status === "pending");
  const done = (captures.data ?? []).filter((c) => c.status !== "pending");
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const lightboxUrl = trpc.attachments.url.useQuery(
    { key: lightboxKey ?? "" },
    { enabled: !!lightboxKey },
  );

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
          <TriageCard key={c.id} capture={c} onZoom={setLightboxKey} />
        ))}
      </div>

      {done.length > 0 && (
        <>
          <h2 className="micro-label text-muted-foreground mt-8 mb-2">Processed</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {done.slice(0, 24).map((c) => (
              <div key={c.id} className="rounded-lg border border-border bg-white p-1.5">
                <div className="relative">
                  {c.kind === "image" && c.storageKey ? (
                    <button
                      className="cursor-zoom-in block w-full"
                      title="Click to view full size"
                      onClick={() => setLightboxKey(c.storageKey)}
                    >
                      <ProcessedThumb storageKey={c.storageKey} kind={c.kind} />
                    </button>
                  ) : (
                    <ProcessedThumb storageKey={c.storageKey} kind={c.kind} />
                  )}
                  {c.kind === "image" && c.storageKey && <PinCaptureButton captureId={c.id} iconOnly />}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground truncate">
                  {c.status} · {timeAgo(c.createdAt)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Dialog open={!!lightboxKey} onOpenChange={(o) => !o && setLightboxKey(null)}>
        <DialogContent className="max-w-4xl p-2 bg-black/95 border-none">
          {lightboxUrl.data?.url && (
            <img src={lightboxUrl.data.url} alt="" className="w-full h-auto max-h-[85vh] object-contain rounded" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
