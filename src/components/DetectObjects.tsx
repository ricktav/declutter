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
import { AiProgressBar } from "@/components/AiProgressBar";
import { Box } from "@/components/CropBox";
import { setLastRoomId } from "@/lib/lastRoom";
import { useLastRoomId } from "@/hooks/use-last-room";
import { useHouse } from "@/context/house";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  discardDetection,
  framesOnPhoto,
  hiddenExistingCount,
  isMatchedOpenSuggestion,
  toggleSelection,
  visibleDetections,
} from "@/lib/detectFrames";
import { Check, Loader2, ScanSearch, AlertTriangle, RefreshCw, X } from "lucide-react";

type Suggestion = {
  key: string;
  label: string;
  description: string | null;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  matchedItemId: number | null;
  matchedItemName: string | null;
  matchScore: number;
  state: "open" | "filed";
};

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
  const isMobile = useIsMobile();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [captureKey, setCaptureKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [newName, setNewName] = useState("");
  const [newArea, setNewArea] = useState<number | null>(null);
  const { houseId } = useHouse();
  const houseRooms = trpc.rooms.list.useQuery({ houseId }, { enabled: houseId != null });
  const lastRoomId = useLastRoomId();
  const [roomId, setRoomIdRaw] = useState<number | null>(null);
  const [roomTouched, setRoomTouched] = useState(false);
  if (!roomTouched && roomId == null && lastRoomId != null) setRoomIdRaw(lastRoomId);
  const setRoomId = (id: number | null) => {
    setRoomTouched(true);
    setRoomIdRaw(id);
  };
  const areas = trpc.areas.list.useQuery();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const captureQuery = trpc.inbox.list.useQuery(undefined, { enabled: open });
  const capture = (captureQuery.data ?? []).find((c) => c.id === captureId) ?? null;
  const imgUrl = trpc.photos.url.useQuery(
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
      setShowAll(false);
      setAiError(null);
      setMode("existing");
      setNewName("");
      // best available default while detection runs - a specific location
      // from an already-recognized item in this same photo wins once
      // detection comes back (see detect.onSuccess below)
      setRoomIdRaw(null);
      setRoomTouched(false);
    }
  }, [open]);

  const detect = trpc.inbox.detectObjects.useMutation({
    onSuccess: async (res) => {
      if (!res.ok) {
        setAiError(res.error);
        return;
      }
      setAiError(null);
      setSuggestions(
        res.suggestions.map((s, i) => ({
          ...s,
          description: s.description ?? null,
          key: `${i}-${s.label}`,
          state: "open",
        })),
      );
      // leave nothing selected so every new (not already-known) frame shows
      setSelected(null);

      // everything in one photo is almost certainly in the same room - if
      // any object was recognized as an item we already know the location
      // of, default the whole batch to that instead of the generic last-
      // used-anywhere context
      const matched = res.suggestions.find((s) => s.matchedItemId != null);
      if (matched?.matchedItemId) {
        const item = await utils.items.get.fetch({ id: matched.matchedItemId });
        if (item?.roomId != null && houseRooms.data?.some((r) => r.id === item.roomId)) setRoomId(item.roomId);
      }
    },
    onError: (e) => setAiError(e.message),
  });

  // run detection the moment the modal has something to detect on, instead
  // of making "detect objects" from the Inbox require a second click here
  const autoDetectRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !captureId || !capture?.storageKey) return;
    if (autoDetectRef.current === captureId) return;
    autoDetectRef.current = captureId;
    detect.mutate({ id: captureId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, captureId, capture?.storageKey]);
  const fileObject = trpc.inbox.fileObject.useMutation({
    onSuccess: () => {
      setLastRoomId(roomId);
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

  const listed = visibleDetections(suggestions, showAll, isMatchedOpenSuggestion);
  const hiddenExisting = hiddenExistingCount(suggestions, isMatchedOpenSuggestion);
  const framed = framesOnPhoto(listed, selected, (s) => s.key);
  const listedKeys = listed.map((s) => s.key).join(",");
  const sel = listed.find((s) => s.key === selected) ?? null;
  const selAreaDefault = areas.data?.[0]?.id ?? null;

  useEffect(() => {
    if (selected == null) return;
    if (!listedKeys.split(",").filter(Boolean).includes(selected)) {
      setSelected(null);
      return;
    }
    rowRefs.current[selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, listedKeys]);

  const select = (key: string) => setSelected((cur) => toggleSelection(cur, key));

  const discard = (key: string) => {
    // detections here are suggestions only — hide this one, never a saved Thing / photo / file
    const next = discardDetection(suggestions, key, selected, (s) => s.key);
    setSuggestions(next.rows);
    setSelected(next.selectedKey);
  };

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
      roomId,
      markProcessed,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="full">
        <DialogHeader>
          <DialogTitle>Detect objects in snap</DialogTitle>
          <p className="text-[12px] text-muted-foreground">
            Boxes are the cutouts — drag to move, corner handle to resize. Tap a frame or a row to focus it.
          </p>
        </DialogHeader>

        <div className="flex flex-col lg:flex-row gap-4 items-start h-[calc(100dvh-7rem)]">
          <div className="flex-1 min-w-0 min-h-[40vh] rounded-lg border border-border bg-white p-2 overflow-auto h-full flex items-center justify-center">
            {imgUrl.isError ? (
              <div className="py-16 text-center text-[13px]">
                <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 inline-block">
                  Photo unavailable: {imgUrl.error instanceof Error ? imgUrl.error.message : "could not resolve URL"}
                  <div className="mt-0.5 font-data text-[10px] break-all text-amber-700">key: {captureKey}</div>
                </div>
              </div>
            ) : imgUrl.data?.url ? (
              <div className="relative inline-block select-none max-w-full">
                <img src={imgUrl.data.url} alt="snap" className="block max-h-[calc(100dvh-9rem)] max-w-full w-auto h-auto rounded" draggable={false} />
                {framed.map((s) => (
                  <Box
                    key={s.key}
                    box={s}
                    color={
                      s.state === "filed"
                        ? "#16a34a"
                        : s.key === selected
                          ? "#7c3aed"
                          : isMatchedOpenSuggestion(s)
                            ? "#94a3b8"
                            : "#a78bfa"
                    }
                    selected={s.key === selected}
                    label={s.matchedItemName ?? s.label}
                    description={s.description}
                    showInlineLabel={s.key === selected && (isMobile || !!s.description || !!s.label)}
                    onSelect={() => select(s.key)}
                    onChange={(b) =>
                      setSuggestions((prev) => prev.map((p) => (p.key === s.key ? { ...p, ...b } : p)))
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="py-16 text-center text-[13px] text-muted-foreground">Loading photo…</div>
            )}
          </div>

          <aside className="w-full lg:w-80 shrink-0 space-y-3 overflow-y-auto h-full pb-4">
            <Button
              size="sm"
              variant={suggestions.length > 0 ? "outline" : "default"}
              className="w-full h-8 text-[12px]"
              disabled={detect.isPending || !capture?.storageKey}
              onClick={() => captureId && detect.mutate({ id: captureId })}
            >
              {detect.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : suggestions.length > 0 ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              ) : (
                <ScanSearch className="h-3.5 w-3.5 mr-1" />
              )}
              {suggestions.length > 0 ? "Re-detect" : "Detect objects"}
            </Button>
            <AiProgressBar active={detect.isPending} action="inbox.detectObjects" />
            {aiError && (
              <div className="flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {aiError}
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="space-y-1">
                <label className="flex items-center justify-between gap-2 px-0.5 text-[12px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                      className="h-4 w-4 accent-[#7c3aed]"
                      aria-label="Show all detections, including ones that already exist as a Thing"
                    />
                    Show all
                  </span>
                  <span className="font-data">
                    {hiddenExisting === 0
                      ? "none existing"
                      : showAll
                        ? `${hiddenExisting} existing`
                        : `${hiddenExisting} existing hidden`}
                  </span>
                </label>
                <div className="space-y-1 max-h-44 overflow-y-auto">
                  {listed.map((s, i) => (
                    <div
                      key={s.key}
                      ref={(el) => {
                        rowRefs.current[s.key] = el;
                      }}
                      className={`flex items-center gap-1 rounded border ${
                        s.key === selected
                          ? "border-violet-400 bg-violet-50"
                          : s.state === "filed"
                            ? "border-emerald-300 bg-emerald-50/60"
                            : isMatchedOpenSuggestion(s)
                              ? "border-border bg-muted/40"
                              : "border-border bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => select(s.key)}
                        className="min-w-0 flex-1 px-2 py-1.5 text-left text-[12px]"
                      >
                        <span className="font-data text-[10px] text-muted-foreground mr-1">{i + 1}.</span>
                        {s.label}
                        {isMatchedOpenSuggestion(s) && (
                          <span className="ml-1 rounded bg-slate-200 px-1 py-0.5 font-data text-[10px] text-slate-700">
                            existing
                          </span>
                        )}
                        {s.state === "filed" && <span className="ml-1 text-emerald-700 text-[10px]">✓ filed</span>}
                      </button>
                      {s.state === "open" && (
                        <button
                          type="button"
                          className="mr-1 h-6 w-6 shrink-0 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title="Discard this detection"
                          aria-label={`Discard ${s.label}`}
                          onClick={() => discard(s.key)}
                        >
                          <X className="h-3.5 w-3.5 mx-auto" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
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
                      new Thing
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
                    <div className="text-[10px] text-muted-foreground mt-0.5">cutout joins this Thing's photo angles</div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <input
                      className="w-full rounded border border-input bg-white px-2 py-1 text-[12px]"
                      placeholder="new Thing name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                    <AreaPicker value={newArea} onChange={setNewArea} />
                  </div>
                )}

                <RoomPicker value={roomId} onChange={setRoomId} houseId={houseId ?? undefined} allowNone />

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
                All objects filed. Close this window — the snap is in your Sort history.
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
