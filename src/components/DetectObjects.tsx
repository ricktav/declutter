import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AreaPicker } from "@/components/AreaPicker";
import { RoomPicker } from "@/components/RoomPicker";
import { Check, Loader2, ScanSearch, AlertTriangle } from "lucide-react";

type Suggestion = {
  key: string;
  label: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  matchedItemId: number | null;
  matchedItemName: string | null;
  matchScore: number;
  state: "open" | "filed";
};

/** One draggable/resizable detection box on the original snap. */
function Box({
  box,
  color,
  onChange,
}: {
  box: { xPct: number; yPct: number; wPct: number; hPct: number };
  color: string;
  onChange: (b: { xPct: number; yPct: number; wPct: number; hPct: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "resize"; startX: number; startY: number; orig: typeof box } | null>(null);

  const onPointerDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...box } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = ref.current?.parentElement?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = ((e.clientX - d.startX) / rect.width) * 100;
    const dy = ((e.clientY - d.startY) / rect.height) * 100;
    if (d.mode === "move") {
      onChange({
        ...d.orig,
        xPct: Math.min(100, Math.max(0, d.orig.xPct + dx)),
        yPct: Math.min(100, Math.max(0, d.orig.yPct + dy)),
      });
    } else {
      onChange({
        ...d.orig,
        wPct: Math.min(100, Math.max(4, d.orig.wPct + dx)),
        hPct: Math.min(100, Math.max(4, d.orig.hPct + dy)),
      });
    }
  };
  const onPointerUp = () => (drag.current = null);

  return (
    <div
      ref={ref}
      className="absolute border-2 touch-none"
      style={{
        left: `${box.xPct - box.wPct / 2}%`,
        top: `${box.yPct - box.hPct / 2}%`,
        width: `${box.wPct}%`,
        height: `${box.hPct}%`,
        borderColor: color,
        background: `${color}14`,
        cursor: "move",
      }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 rounded-sm border-2 bg-white"
        style={{ borderColor: color, cursor: "nwse-resize" }}
        onPointerDown={(e) => onPointerDown(e, "resize")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}

export function DetectObjectsModal({
  captureId,
  open,
  onClose,
}: {
  captureId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [captureKey, setCaptureKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [newName, setNewName] = useState("");
  const [newArea, setNewArea] = useState<number | null>(null);
  const [loc, setLoc] = useState<{ houseId: number | null; floor: string; room: string }>({
    houseId: null,
    floor: "",
    room: "",
  });
  const areas = trpc.areas.list.useQuery();

  const captureQuery = trpc.inbox.list.useQuery(undefined, { enabled: open });
  const capture = (captureQuery.data ?? []).find((c) => c.id === captureId) ?? null;
  const imgUrl = trpc.attachments.url.useQuery(
    { key: captureKey ?? "" },
    { enabled: open && !!captureKey },
  );

  useEffect(() => {
    if (capture?.storageKey) setCaptureKey(capture.storageKey);
  }, [capture?.storageKey]);

  // reset when reopened
  useEffect(() => {
    if (open) {
      setSuggestions([]);
      setSelected(null);
      setAiError(null);
      setMode("existing");
      setNewName("");
      setLoc({ houseId: null, floor: "", room: "" });
    }
  }, [open]);

  const detect = trpc.inbox.detectObjects.useMutation({
    onSuccess: (res) => {
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      setAiError(null);
      setSuggestions(
        res.suggestions.map((s, i) => ({
          ...s,
          key: `${i}-${s.label}`,
          state: "open",
        })),
      );
      setSelected(res.suggestions[0] ? `0-${res.suggestions[0].label}` : null);
    },
    onError: (e) => setAiError(e.message),
  });
  const fileObject = trpc.inbox.fileObject.useMutation({
    onSuccess: () => {
      setSuggestions((prev) =>
        prev.map((s) => (s.key === selected ? { ...s, state: "filed" as const } : s)),
      );
      utils.inbox.list.invalidate();
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
      const next = suggestions.find((s) => s.key !== selected && s.state === "open");
      setSelected(next?.key ?? null);
    },
  });

  const sel = suggestions.find((s) => s.key === selected) ?? null;
  const selAreaDefault = areas.data?.[0]?.id ?? null;

  const file = (markProcessed: boolean) => {
    if (!sel || !captureId) return;
    fileObject.mutate({
      id: captureId,
      label: sel.label,
      xPct: sel.xPct,
      yPct: sel.yPct,
      wPct: sel.wPct,
      hPct: sel.hPct,
      itemId: mode === "existing" ? sel.matchedItemId : null,
      itemName: mode === "existing" ? (sel.matchedItemName ?? sel.label) : newName.trim() || sel.label,
      areaId: newArea ?? selAreaDefault ?? 0,
      houseId: loc.houseId ?? null,
      floor: loc.floor || undefined,
      room: loc.room || undefined,
      markProcessed,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-screen h-[100dvh] max-w-none sm:max-w-none rounded-none p-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Detect objects in snap — drag boxes on the original, file each as a cutout</DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 items-start h-[calc(100dvh-7rem)]">
          <div className="flex-1 min-w-0 rounded-lg border border-border bg-white p-2 overflow-auto h-full flex items-start">
            {imgUrl.isError ? (
              <div className="py-16 text-center text-[13px]">
                <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 inline-block">
                  Photo unavailable: {imgUrl.error instanceof Error ? imgUrl.error.message : "could not resolve URL"}
                  <div className="mt-0.5 font-data text-[10px] break-all text-amber-700">key: {captureKey}</div>
                </div>
              </div>
            ) : imgUrl.data?.url ? (
              <div className="relative select-none mx-auto">
                <img src={imgUrl.data.url} alt="snap" className="max-h-[calc(100dvh-9rem)] w-auto rounded" draggable={false} />
                {suggestions.map((s) => (
                  <Box
                    key={s.key}
                    box={s}
                    color={s.state === "filed" ? "#16a34a" : s.key === selected ? "#7c3aed" : "#94a3b8"}
                    onChange={(b) =>
                      setSuggestions((prev) => prev.map((p) => (p.key === s.key ? { ...p, ...b } : p)))
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="py-16 text-center text-[13px] text-muted-foreground">Loading photo…</div>
            )}
            <div className="mt-2 text-[11px] text-muted-foreground">
              Full-size view. Boxes are the cutouts — drag to move, corner handle to resize. Each confirmed object
              gets its own cropped image linked to the item (more snaps = more angles).
            </div>
          </div>

          <aside className="w-80 shrink-0 space-y-3 overflow-y-auto h-full pb-4">
            <Button
              size="sm"
              className="w-full h-8 text-[12px]"
              disabled={detect.isPending || !capture?.storageKey}
              onClick={() => captureId && detect.mutate({ id: captureId })}
            >
              {detect.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5 mr-1" />
              )}
              Detect objects
            </Button>
            {aiError && (
              <div className="flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {aiError}
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="space-y-1 max-h-44 overflow-y-auto">
                {suggestions.map((s, i) => (
                  <button
                    key={s.key}
                    onClick={() => setSelected(s.key)}
                    className={`w-full rounded border px-2 py-1.5 text-left text-[12px] ${
                      s.key === selected
                        ? "border-violet-400 bg-violet-50"
                        : s.state === "filed"
                          ? "border-emerald-300 bg-emerald-50/60"
                          : "border-border bg-white"
                    }`}
                  >
                    <span className="font-data text-[10px] text-muted-foreground mr-1">{i + 1}.</span>
                    {s.label}
                    {s.state === "filed" && <span className="ml-1 text-emerald-700 text-[10px]">✓ filed</span>}
                  </button>
                ))}
              </div>
            )}

            {sel && sel.state === "open" && (
              <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 space-y-2">
                <div>
                  <div className="micro-label text-muted-foreground">Name</div>
                  <input
                    className="mt-0.5 w-full rounded border border-input bg-white px-2 py-1 text-[13px]"
                    value={sel.label}
                    onChange={(e) =>
                      setSuggestions((prev) => prev.map((p) => (p.key === sel.key ? { ...p, label: e.target.value } : p)))
                    }
                  />
                </div>
                {sel.matchedItemId && sel.matchedItemName ? (
                  <div className="flex items-center gap-1.5 text-[12px]">
                    <button
                      onClick={() => setMode(mode === "existing" ? "new" : "existing")}
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        mode === "existing" ? "bg-violet-600 text-white" : "bg-muted"
                      }`}
                    >
                      existing
                    </button>
                    <button
                      onClick={() => setMode("new")}
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        mode === "new" ? "bg-violet-600 text-white" : "bg-muted"
                      }`}
                    >
                      new item
                    </button>
                  </div>
                ) : null}

                {mode === "existing" && sel.matchedItemId ? (
                  <div className="text-[12px]">
                    <Link to={`/items/${sel.matchedItemId}`} className="text-primary hover:underline font-medium">
                      {sel.matchedItemName}
                    </Link>
                    <span className="ml-1.5 rounded bg-white border border-border px-1 py-0.5 font-data text-[10px]">
                      {sel.matchScore}% match
                    </span>
                    <div className="text-[10px] text-muted-foreground mt-0.5">cutout joins this item's photo angles</div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <input
                      className="w-full rounded border border-input bg-white px-2 py-1 text-[12px]"
                      placeholder="new item name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                    <AreaPicker value={newArea} onChange={setNewArea} />
                  </div>
                )}

                <RoomPicker value={loc} onChange={setLoc} />

                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-7 text-[12px] flex-1"
                    disabled={fileObject.isPending || (mode === "new" && !(newName.trim() || sel.label.trim()))}
                    onClick={() => file(false)}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    {fileObject.isPending ? "Filing…" : "File + next"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[12px]"
                    disabled={fileObject.isPending}
                    onClick={() => file(true)}
                  >
                    File + done
                  </Button>
                </div>
              </div>
            )}
            {suggestions.length > 0 && suggestions.every((s) => s.state === "filed") && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                All objects filed. Close this window — the snap is in your inbox history.
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
