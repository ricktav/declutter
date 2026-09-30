import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { ItemPicker } from "@/components/ItemPicker";
import { AreaPicker } from "@/components/AreaPicker";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  Check,
  X,
  Plus,
  ArrowLeft,
  Flag,
} from "lucide-react";

type Draft = { label: string; item: { id: number; name: string } | null };

/** Shows the linked item, and warns if it's already confirmed on a pin
 * elsewhere - could be the same physical object seen twice, or a similar
 * but distinct one (a second Sonos speaker, another matching chair) that
 * should really get its own item record. */
function LinkedItemChip({
  item,
  currentAttachmentId,
  onUnlink,
}: {
  item: { id: number; name: string };
  currentAttachmentId: number;
  onUnlink: () => void;
}) {
  const pins = trpc.annotations.listForItem.useQuery({ itemId: item.id });
  const elsewhere = (pins.data ?? []).filter(
    (p) => p.status === "confirmed" && p.attachmentId !== currentAttachmentId,
  );
  return (
    <div className="text-[12px] rounded bg-accent px-2 py-1 space-y-1">
      <div className="flex items-center gap-1">
        linked: <b>{item.name}</b>
        <button className="ml-auto" onClick={onUnlink}>
          <X className="h-3 w-3" />
        </button>
      </div>
      {elsewhere.length > 0 && (
        <div className="flex items-start gap-1 text-amber-700">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Already pinned {elsewhere.length}× elsewhere — make sure this is the same physical object, not a
            similar one that needs its own item.
          </span>
        </div>
      )}
    </div>
  );
}

// A suggestion this close to (or overlapping) an already-confirmed pin with
// the same-ish label is almost certainly the same physical object re-detected
// - hide it rather than let it become a duplicate tag on re-run.
function isLikelyDuplicate(sugg: Pin, confirmedPins: Pin[]): boolean {
  const sLabel = sugg.label.trim().toLowerCase();
  if (!sLabel) return false;
  const hw = (sugg.wPct ?? 10) / 2;
  const hh = (sugg.hPct ?? 10) / 2;
  return confirmedPins.some((c) => {
    const near = Math.abs(c.xPct - sugg.xPct) <= hw + 4 && Math.abs(c.yPct - sugg.yPct) <= hh + 4;
    if (!near) return false;
    const cLabel = (c.itemName || c.label || "").trim().toLowerCase();
    if (!cLabel) return false;
    return cLabel === sLabel || cLabel.includes(sLabel) || sLabel.includes(cLabel);
  });
}

type Pin = {
  id: number;
  xPct: number;
  yPct: number;
  wPct: number | null;
  hPct: number | null;
  label: string;
  itemId: number | null;
  itemName: string | null;
  itemAreaColor: string | null;
  origin: "user" | "ai";
  status: "suggested" | "confirmed";
  flagged: boolean;
};

export default function AnnotatePage() {
  const { attachmentId } = useParams<{ attachmentId: string }>();
  const attId = Number(attachmentId);
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const imgRef = useRef<HTMLImageElement>(null);

  const pinsQuery = trpc.annotations.listForAttachment.useQuery({ attachmentId: attId });
  const urlQuery = trpc.attachments.urlForAttachment.useQuery({ attachmentId: attId });
  const areas = trpc.areas.list.useQuery();

  const [pending, setPending] = useState<{ xPct: number; yPct: number; wPct?: number; hPct?: number } | null>(null);
  const [drawingBox, setDrawingBox] = useState<{ xPct: number; yPct: number; wPct: number; hPct: number } | null>(
    null,
  );
  const drawStart = useRef<{ xPct: number; yPct: number } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingItem, setPendingItem] = useState<{ id: number; name: string } | null>(null);
  const [newItemArea, setNewItemArea] = useState<number | "">("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [detectInfo, setDetectInfo] = useState<string | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<number | null>(null);
  const [hoveredSuggestionId, setHoveredSuggestionId] = useState<number | null>(null);
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<number, Draft>>({});
  const [editingPinId, setEditingPinId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editItem, setEditItem] = useState<{ id: number; name: string } | null>(null);
  const [resizeBox, setResizeBox] = useState<
    Record<number, { xPct: number; yPct: number; wPct: number; hPct: number }>
  >({});
  const resizing = useRef<{
    id: number;
    corner: "tl" | "tr" | "bl" | "br";
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);

  const invalidate = () => utils.annotations.listForAttachment.invalidate({ attachmentId: attId });

  const addPin = trpc.annotations.add.useMutation({ onSuccess: invalidate });
  const resolve = trpc.annotations.resolve.useMutation({
    onSuccess: () => {
      invalidate();
      utils.events.list.invalidate();
    },
  });
  const removePin = trpc.annotations.remove.useMutation({ onSuccess: invalidate });
  const reposition = trpc.annotations.update.useMutation({ onSuccess: invalidate });
  const [dragPos, setDragPos] = useState<Record<number, { xPct: number; yPct: number }>>({});
  const dragging = useRef<number | null>(null);
  const createItem = trpc.items.create.useMutation();
  const detect = trpc.annotations.detect.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setAiError(null);
        setDetectInfo(
          res.created === 0
            ? "No objects detected."
            : `Detected ${res.created} object${res.created === 1 ? "" : "s"} — ${res.matched} matched your inventory.`,
        );
        invalidate();
      } else setAiError(res.error);
    },
    onError: (e) => setAiError(e.message),
  });

  useEffect(() => {
    if (areas.data?.length && newItemArea === "") {
      setNewItemArea(areas.data[0].id);
    }
  }, [areas.data, newItemArea]);

  const pins: Pin[] = pinsQuery.data ?? [];
  const confirmed = pins.filter((p) => p.status === "confirmed");
  const suggestedAll = pins.filter((p) => p.status === "suggested");
  const visibleSuggested = suggestedAll.filter((p) => !isLikelyDuplicate(p, confirmed));
  const hiddenDuplicateCount = suggestedAll.length - visibleSuggested.length;
  const pinNumber = new Map(pins.map((p, i) => [p.id, i + 1]));
  const editingPin = confirmed.find((p) => p.id === editingPinId) ?? null;

  // current on-screen box for a pin, folding in any in-progress drag/resize
  const boxFor = (p: Pin) => {
    const resized = resizeBox[p.id];
    const moved = dragPos[p.id];
    return {
      xPct: resized?.xPct ?? moved?.xPct ?? p.xPct,
      yPct: resized?.yPct ?? moved?.yPct ?? p.yPct,
      wPct: resized?.wPct ?? p.wPct ?? undefined,
      hPct: resized?.hPct ?? p.hPct ?? undefined,
    };
  };

  const getDraft = (p: Pin): Draft =>
    suggestionDrafts[p.id] ?? { label: p.label, item: p.itemId && p.itemName ? { id: p.itemId, name: p.itemName } : null };
  const setDraft = (p: Pin, next: Partial<Draft>) => {
    // merge against the updater's own `prev`, not the outer getDraft(p) - two
    // setDraft calls can land in the same batch (ItemPicker fires onSelect
    // then onQueryChange), and merging from a stale outer snapshot in both
    // would let the second call silently overwrite the first's fields
    setSuggestionDrafts((prev) => {
      const current =
        prev[p.id] ?? { label: p.label, item: p.itemId && p.itemName ? { id: p.itemId, name: p.itemName } : null };
      return { ...prev, [p.id]: { ...current, ...next } };
    });
  };
  const confirmSuggestion = (p: Pin) => {
    const draft = getDraft(p);
    // once linked, the item's own name IS the label - a free-text AI
    // description ("ultrawide monitor") shouldn't outlive the link to the
    // actual inventory record ("Samsung ultrawide monitor")
    const label = draft.item ? draft.item.name : draft.label;
    resolve.mutate({ id: p.id, confirm: true, label, itemId: draft.item?.id ?? null });
    setSuggestionDrafts((prev) => {
      const { [p.id]: _drop, ...rest } = prev;
      return rest;
    });
    if (selectedSuggestionId === p.id) setSelectedSuggestionId(null);
  };
  const rejectSuggestion = (p: Pin) => {
    resolve.mutate({ id: p.id, confirm: false });
    setSuggestionDrafts((prev) => {
      const { [p.id]: _drop, ...rest } = prev;
      return rest;
    });
    if (selectedSuggestionId === p.id) setSelectedSuggestionId(null);
  };

  const onPinPointerDown = (e: React.PointerEvent, pinId: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragging.current = pinId;
  };
  const onPinPointerMove = (e: React.PointerEvent) => {
    const pinId = dragging.current;
    const rect = imgRef.current?.getBoundingClientRect();
    if (!pinId || !rect) return;
    setDragPos((prev) => ({
      ...prev,
      [pinId]: {
        xPct: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
        yPct: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
      },
    }));
  };
  const onPinPointerUp = () => {
    const pinId = dragging.current;
    dragging.current = null;
    if (!pinId) return;
    const pos = dragPos[pinId];
    if (pos) reposition.mutate({ id: pinId, xPct: pos.xPct, yPct: pos.yPct });
  };

  // drag a suggestion frame's corner to resize/reshape its box to match what
  // a human actually sees, instead of trusting the AI's box verbatim
  const onResizeStart = (e: React.PointerEvent, p: Pin, corner: "tl" | "tr" | "bl" | "br") => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const box = boxFor(p);
    const w = box.wPct ?? 10;
    const h = box.hPct ?? 10;
    resizing.current = {
      id: p.id,
      corner,
      left: box.xPct - w / 2,
      top: box.yPct - h / 2,
      right: box.xPct + w / 2,
      bottom: box.yPct + h / 2,
    };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizing.current;
    const rect = imgRef.current?.getBoundingClientRect();
    if (!r || !rect) return;
    const px = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    const py = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
    const next = { ...r };
    if (r.corner === "tl") { next.left = px; next.top = py; }
    else if (r.corner === "tr") { next.right = px; next.top = py; }
    else if (r.corner === "bl") { next.left = px; next.bottom = py; }
    else { next.right = px; next.bottom = py; }
    resizing.current = next;
    const left = Math.min(next.left, next.right);
    const right = Math.max(next.left, next.right);
    const top = Math.min(next.top, next.bottom);
    const bottom = Math.max(next.top, next.bottom);
    setResizeBox((prev) => ({
      ...prev,
      [r.id]: {
        xPct: (left + right) / 2,
        yPct: (top + bottom) / 2,
        wPct: Math.max(2, right - left),
        hPct: Math.max(2, bottom - top),
      },
    }));
  };
  const onResizeEnd = () => {
    const r = resizing.current;
    resizing.current = null;
    if (!r) return;
    const box = resizeBox[r.id];
    if (box) reposition.mutate({ id: r.id, xPct: box.xPct, yPct: box.yPct, wPct: box.wPct, hPct: box.hPct });
  };

  // a plain click drops a point pin; dragging draws a box around the object -
  // both start here, and which one you get is decided on release by how far
  // the pointer actually moved
  const DRAW_THRESHOLD = 1.5; // % of image dimension - below this, it's a click
  const pctFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      xPct: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
      yPct: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
    };
  };
  const onImagePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    const pt = pctFromEvent(e);
    if (!pt) return;
    drawStart.current = pt;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onImagePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const start = drawStart.current;
    const pt = pctFromEvent(e);
    if (!start || !pt) return;
    const left = Math.min(start.xPct, pt.xPct);
    const right = Math.max(start.xPct, pt.xPct);
    const top = Math.min(start.yPct, pt.yPct);
    const bottom = Math.max(start.yPct, pt.yPct);
    if (right - left > DRAW_THRESHOLD || bottom - top > DRAW_THRESHOLD) {
      setDrawingBox({ xPct: (left + right) / 2, yPct: (top + bottom) / 2, wPct: right - left, hPct: bottom - top });
    }
  };
  const onImagePointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    const start = drawStart.current;
    drawStart.current = null;
    const pt = pctFromEvent(e);
    if (!start || !pt) {
      setDrawingBox(null);
      return;
    }
    const left = Math.min(start.xPct, pt.xPct);
    const right = Math.max(start.xPct, pt.xPct);
    const top = Math.min(start.yPct, pt.yPct);
    const bottom = Math.max(start.yPct, pt.yPct);
    const drewBox = right - left > DRAW_THRESHOLD || bottom - top > DRAW_THRESHOLD;
    setPending(
      drewBox
        ? { xPct: (left + right) / 2, yPct: (top + bottom) / 2, wPct: right - left, hPct: bottom - top }
        : { xPct: start.xPct, yPct: start.yPct },
    );
    setDrawingBox(null);
    setPendingLabel("");
    setPendingItem(null);
    setEditingPinId(null);
    setSelectedPinId(null);
    setSelectedSuggestionId(null);
  };

  const openEdit = (p: Pin) => {
    setPending(null);
    setEditingPinId(p.id);
    setSelectedPinId(p.id);
    setEditLabel(p.label);
    setEditItem(p.itemId && p.itemName ? { id: p.itemId, name: p.itemName } : null);
  };

  // accepts an override so selecting an existing item can save immediately
  // (Enter or click) without waiting for pendingItem's state update to land
  const savePending = async (overrideItem?: { id: number; name: string } | null) => {
    if (!pending) return;
    const linkedItem = overrideItem !== undefined ? overrideItem : pendingItem;
    let itemId = linkedItem?.id;
    if (!itemId && pendingLabel.trim() && newItemArea !== "") {
      const res = await createItem.mutateAsync({
        areaId: Number(newItemArea),
        name: pendingLabel.trim(),
      });
      itemId = res.id;
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
    }
    // once linked, the item's own name is the label - not the free-text
    // description that found it
    const label = linkedItem ? linkedItem.name : pendingLabel.trim();
    await addPin.mutateAsync({
      attachmentId: attId,
      xPct: pending.xPct,
      yPct: pending.yPct,
      wPct: pending.wPct,
      hPct: pending.hPct,
      label,
      itemId,
    });
    setPending(null);
  };

  const suggestForBox = trpc.annotations.suggestForBox.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        setAiError(null);
        setPendingLabel(res.label);
        setPendingItem(res.itemId && res.itemName ? { id: res.itemId, name: res.itemName } : null);
      } else {
        setAiError(res.error);
      }
    },
    onError: (e) => setAiError(e.message),
  });

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" className="h-8" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">Annotate photo</h1>
        <span className="text-[12px] text-muted-foreground">
          click to pin · double-click a pin to edit · drag a selected suggestion's corners to resize
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[12px] ml-auto border-violet-300 text-violet-700"
          disabled={detect.isPending}
          onClick={() => {
            setAiError(null);
            setDetectInfo(null);
            detect.mutate({ attachmentId: attId });
          }}
        >
          {detect.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1" />
          )}
          AI detect objects
        </Button>
      </div>

      {aiError && (
        <div className="mt-3 flex gap-2 items-start rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {aiError}
        </div>
      )}
      {detectInfo && (
        <div className="mt-3 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-[12px] text-violet-900">
          {detectInfo} Confirm or reject each suggested pin below.
        </div>
      )}

      <div className="flex gap-6 mt-4 items-start">
        {/* photo + pins */}
        <div className="flex-1 min-w-0 rounded-lg border border-border bg-white p-2">
          {urlQuery.data?.url ? (
            <div className="relative select-none">
              <img
                ref={imgRef}
                src={urlQuery.data.url}
                alt="annotate"
                className="w-full rounded cursor-crosshair touch-none"
                onPointerDown={onImagePointerDown}
                onPointerMove={onImagePointerMove}
                onPointerUp={onImagePointerUp}
                draggable={false}
              />
              <svg
                className="absolute inset-0 h-full w-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {[...visibleSuggested, ...confirmed]
                  .filter((p) => p.wPct != null && p.hPct != null)
                  .filter((p) => p.status === "suggested" || p.id === selectedPinId)
                  .map((p) => {
                    const pos = boxFor(p);
                    const emphasized =
                      p.status === "suggested" && (hoveredSuggestionId === p.id || selectedSuggestionId === p.id);
                    return (
                    <rect
                      key={p.id}
                      x={pos.xPct - (pos.wPct ?? 0) / 2}
                      y={pos.yPct - (pos.hPct ?? 0) / 2}
                      width={pos.wPct ?? 0}
                      height={pos.hPct ?? 0}
                      rx={1.5}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={emphasized ? 3 : 2}
                      fill={
                        p.status === "suggested"
                          ? emphasized
                            ? "rgba(124,58,237,0.20)"
                            : "rgba(124,58,237,0.10)"
                          : p.itemId
                            ? "rgba(210,255,0,0.12)"
                            : "rgba(40,44,32,0.10)"
                      }
                      stroke={
                        p.status === "suggested"
                          ? emphasized
                            ? "#5b21b6"
                            : "#7c3aed"
                          : p.itemId
                            ? "#2d4a22"
                            : "#282c20"
                      }
                      strokeDasharray={p.status === "suggested" ? "4 2" : undefined}
                    />
                    );
                  })}
              </svg>
              {visibleSuggested
                .filter((p) => p.wPct != null && p.hPct != null)
                .map((p) => {
                  const box = boxFor(p);
                  const w = box.wPct ?? 10;
                  const h = box.hPct ?? 10;
                  const isSelected = selectedSuggestionId === p.id;
                  const showIcons = isSelected || hoveredSuggestionId === p.id;
                  // the icon toolbar floats above the box; extend this wrapper's
                  // own hoverable area upward to include it so moving the
                  // mouse up to the icons never exits the hover region (a gap
                  // there means mouseleave fires before the icons are reached)
                  const TOOLBAR_PAD = 40;
                  return (
                    <div
                      key={`frame-${p.id}`}
                      className="absolute cursor-pointer"
                      style={{
                        left: `${box.xPct - w / 2}%`,
                        top: `calc(${box.yPct - h / 2}% - ${TOOLBAR_PAD}px)`,
                        width: `${w}%`,
                        height: `calc(${h}% + ${TOOLBAR_PAD}px)`,
                      }}
                      onMouseEnter={() => setHoveredSuggestionId(p.id)}
                      onMouseLeave={() => setHoveredSuggestionId((cur) => (cur === p.id ? null : cur))}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedSuggestionId(p.id);
                        setSelectedPinId(null);
                      }}
                    >
                      <div
                        data-suggestion-frame={p.id}
                        className="absolute inset-x-0 bottom-0"
                        style={{ top: TOOLBAR_PAD }}
                      >
                        {showIcons && (
                          <div className="absolute -top-8 right-0 flex gap-1 z-10">
                            <button
                              className="h-5 w-5 rounded-full bg-white shadow border border-destructive/50 text-destructive flex items-center justify-center hover:bg-destructive/10"
                              title="Reject suggestion"
                              onClick={(e) => {
                                e.stopPropagation();
                                rejectSuggestion(p);
                              }}
                            >
                              <X className="h-3 w-3" />
                            </button>
                            <button
                              className="h-5 w-5 rounded-full bg-white shadow border border-emerald-500 text-emerald-700 flex items-center justify-center hover:bg-emerald-50"
                              title="Confirm suggestion"
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmSuggestion(p);
                              }}
                            >
                              <Check className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        {isSelected && (
                          <>
                            {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                              <div
                                key={corner}
                                data-resize-handle={`${p.id}-${corner}`}
                                className={cn(
                                  "absolute h-2.5 w-2.5 rounded-sm bg-white border-2 border-violet-600 z-10",
                                  corner === "tl" && "-top-1.5 -left-1.5 cursor-nwse-resize",
                                  corner === "tr" && "-top-1.5 -right-1.5 cursor-nesw-resize",
                                  corner === "bl" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                                  corner === "br" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
                                )}
                                onPointerDown={(e) => onResizeStart(e, p, corner)}
                                onPointerMove={onResizeMove}
                                onPointerUp={onResizeEnd}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              {(() => {
                const p = confirmed.find((c) => c.id === selectedPinId && c.wPct != null);
                if (!p) return null;
                const box = boxFor(p);
                const w = box.wPct ?? 10;
                const h = box.hPct ?? 10;
                return (
                  <div
                    key={`edit-frame-${p.id}`}
                    className="absolute"
                    style={{
                      left: `${box.xPct - w / 2}%`,
                      top: `${box.yPct - h / 2}%`,
                      width: `${w}%`,
                      height: `${h}%`,
                    }}
                  >
                    {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                      <div
                        key={corner}
                        data-resize-handle={`${p.id}-${corner}`}
                        className={cn(
                          "absolute h-2.5 w-2.5 rounded-sm bg-white border-2 border-[#2d4a22] z-10",
                          corner === "tl" && "-top-1.5 -left-1.5 cursor-nwse-resize",
                          corner === "tr" && "-top-1.5 -right-1.5 cursor-nesw-resize",
                          corner === "bl" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                          corner === "br" && "-bottom-1.5 -right-1.5 cursor-nwse-resize",
                        )}
                        onPointerDown={(e) => onResizeStart(e, p, corner)}
                        onPointerMove={onResizeMove}
                        onPointerUp={onResizeEnd}
                      />
                    ))}
                  </div>
                );
              })()}
              {pins.map((p) => {
                const pos = boxFor(p);
                const i = pinNumber.get(p.id)! - 1;
                return (
                <div
                  key={p.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 group cursor-grab active:cursor-grabbing touch-none"
                  style={{ left: `${pos.xPct}%`, top: `${pos.yPct}%` }}
                  onPointerDown={(e) => onPinPointerDown(e, p.id)}
                  onPointerMove={onPinPointerMove}
                  onPointerUp={onPinPointerUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.status === "confirmed" && p.wPct != null) {
                      setSelectedPinId((cur) => (cur === p.id ? null : p.id));
                      setSelectedSuggestionId(null);
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (p.status === "confirmed") openEdit(p);
                  }}
                >
                  <div
                    className={`flex items-center justify-center h-6 w-6 rounded-full border-2 text-[10px] font-data shadow ${
                      p.flagged
                        ? "border-amber-600 bg-amber-400 text-amber-950"
                        : p.status === "suggested"
                          ? "border-violet-500 bg-violet-500/80 text-white border-dashed"
                          : p.itemId && p.itemAreaColor
                            ? "border-white/70 text-white"
                            : p.itemId
                              ? "border-[#2d4a22] bg-[#d2ff00] text-[#282c20]"
                              : "border-white bg-[#282c20] text-white"
                    }`}
                    style={
                      !p.flagged && p.status !== "suggested" && p.itemId && p.itemAreaColor
                        ? { background: p.itemAreaColor }
                        : undefined
                    }
                  >
                    {i + 1}
                  </div>
                  <div className="absolute left-1/2 -translate-x-1/2 top-7 whitespace-nowrap rounded bg-black/80 text-white text-[10px] px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    {p.itemName || p.label || "untitled"}
                  </div>
                </div>
                );
              })}
              {drawingBox && (
                <div
                  className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
                  style={{
                    left: `${drawingBox.xPct - drawingBox.wPct / 2}%`,
                    top: `${drawingBox.yPct - drawingBox.hPct / 2}%`,
                    width: `${drawingBox.wPct}%`,
                    height: `${drawingBox.hPct}%`,
                  }}
                />
              )}
              {pending && (
                <>
                  {pending.wPct != null && pending.hPct != null && (
                    <div
                      className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
                      style={{
                        left: `${pending.xPct - pending.wPct / 2}%`,
                        top: `${pending.yPct - pending.hPct / 2}%`,
                        width: `${pending.wPct}%`,
                        height: `${pending.hPct}%`,
                      }}
                    />
                  )}
                  <div
                    className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                    style={{ left: `${pending.xPct}%`, top: `${pending.yPct}%` }}
                  >
                    <div className="flex items-center justify-center h-6 w-6 rounded-full border-2 border-primary bg-primary text-primary-foreground text-[10px] font-data shadow animate-pulse">
                      {pins.length + 1}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="py-20 text-center text-sm text-muted-foreground">
              {urlQuery.isLoading ? "Loading photo…" : "Photo unavailable (storage not provisioned?)"}
            </div>
          )}
        </div>

        {/* side panel */}
        <aside className="w-80 shrink-0 space-y-4">
          {editingPin && (
            <div className="rounded-lg border border-primary bg-white p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="micro-label text-primary">
                  Edit pin {pinNumber.get(editingPin.id)}
                </div>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setEditingPinId(null)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <ItemPicker
                placeholder="Search or name this object…"
                value={editLabel}
                onQueryChange={(v) => {
                  setEditLabel(v);
                  if (editItem) setEditItem(null);
                }}
                onSelect={(item) => {
                  setEditItem(item);
                  setEditLabel(item.name);
                }}
                allowCreate
                onCreateNew={(name) => {
                  setEditLabel(name);
                  setEditItem(null);
                }}
                autoFocus
              />
              {editItem && (
                <LinkedItemChip item={editItem} currentAttachmentId={attId} onUnlink={() => setEditItem(null)} />
              )}
              <div className="flex gap-2 justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[12px] text-destructive hover:text-destructive"
                  onClick={() => {
                    removePin.mutate({ id: editingPin.id });
                    setEditingPinId(null);
                  }}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Delete
                </Button>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setEditingPinId(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-[12px]"
                    disabled={reposition.isPending}
                    onClick={() => {
                      const label = editItem ? editItem.name : editLabel.trim();
                      reposition.mutate({ id: editingPin.id, label, itemId: editItem?.id ?? null });
                      setEditingPinId(null);
                    }}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" /> Save
                  </Button>
                </div>
              </div>
            </div>
          )}

          {pending && (
            <div className="rounded-lg border border-primary bg-white p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="micro-label text-primary">New pin</div>
                {pending.wPct == null && (
                  <span className="text-[11px] text-muted-foreground">drag to draw a box</span>
                )}
              </div>
              {pending.wPct != null && pending.hPct != null && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[12px] w-full border-violet-300 text-violet-700"
                  disabled={suggestForBox.isPending}
                  onClick={() =>
                    suggestForBox.mutate({
                      attachmentId: attId,
                      xPct: pending.xPct,
                      yPct: pending.yPct,
                      wPct: pending.wPct!,
                      hPct: pending.hPct!,
                    })
                  }
                >
                  {suggestForBox.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                  )}
                  AI suggest label
                </Button>
              )}
              <ItemPicker
                placeholder="Search or name this object…"
                value={pendingLabel}
                onQueryChange={(v) => {
                  setPendingLabel(v);
                  if (pendingItem) setPendingItem(null);
                }}
                onSelect={async (item) => {
                  setPendingItem(item);
                  setPendingLabel(item.name);
                  // an item already pinned elsewhere is worth a second look
                  // before auto-adding - skip the instant-save and let the
                  // warning on the chip below surface first
                  const existing = await utils.annotations.listForItem.fetch({ itemId: item.id });
                  const elsewhere = existing.filter((p) => p.status === "confirmed" && p.attachmentId !== attId);
                  if (elsewhere.length === 0) savePending(item);
                }}
                allowCreate
                onCreateNew={(name) => {
                  setPendingLabel(name);
                  setPendingItem(null);
                }}
                autoFocus
              />
              {pendingItem && (
                <LinkedItemChip item={pendingItem} currentAttachmentId={attId} onUnlink={() => setPendingItem(null)} />
              )}
              {!pendingItem && pendingLabel.trim() && (
                <div className="space-y-1 text-[12px]">
                  <span className="text-muted-foreground">create as new item in</span>
                  <AreaPicker
                    value={newItemArea === "" ? null : newItemArea}
                    onChange={(id) => setNewItemArea(id)}
                  />
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setPending(null)}>
                  Cancel
                </Button>
                <Button size="sm" className="h-7 text-[12px]" onClick={() => savePending()}
                  disabled={addPin.isPending || createItem.isPending}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add pin
                </Button>
              </div>
            </div>
          )}

          {visibleSuggested.length > 0 && (
            <div className="rounded-lg border border-violet-300 bg-violet-50/60 p-3 space-y-2">
              <div className="micro-label text-violet-700">AI suggestions ({visibleSuggested.length})</div>
              {hiddenDuplicateCount > 0 && (
                <div className="text-[11px] text-violet-700/70">
                  {hiddenDuplicateCount} likely duplicate{hiddenDuplicateCount === 1 ? "" : "s"} of an existing pin hidden
                </div>
              )}
              {visibleSuggested.map((p) => (
                <SuggestedPinRow
                  key={p.id}
                  number={pinNumber.get(p.id) ?? 0}
                  draft={getDraft(p)}
                  onDraftChange={(next) => setDraft(p, next)}
                  selected={selectedSuggestionId === p.id}
                  onSelect={() => setSelectedSuggestionId(p.id)}
                  onConfirm={() => confirmSuggestion(p)}
                  onReject={() => rejectSuggestion(p)}
                  currentAttachmentId={attId}
                />
              ))}
            </div>
          )}

          <div className="rounded-lg border border-border bg-white p-3">
            <div className="micro-label text-muted-foreground mb-2">Pins ({confirmed.length})</div>
            {confirmed.length === 0 && (
              <div className="text-[12px] text-muted-foreground">
                None yet — click the photo to pin by hand, or run AI detection (boxes + pins for up to 15 objects).
              </div>
            )}
            <div className="space-y-1.5">
              {confirmed.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2 text-[13px] group">
                  <span className="font-data text-[11px] text-muted-foreground w-5">{i + 1}.</span>
                  <span className="flex-1 min-w-0 truncate">
                    {p.itemId && p.itemName ? (
                      <Link to={`/items/${p.itemId}`} className="text-primary hover:underline">
                        {p.itemName}
                      </Link>
                    ) : (
                      p.label || <span className="text-muted-foreground">untitled</span>
                    )}
                  </span>
                  {!p.itemId && <span className="text-[10px] text-muted-foreground shrink-0">unlinked</span>}
                  <button
                    className={p.flagged ? "text-amber-600" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-600"}
                    title={p.flagged ? "Needs attention — click to clear" : "Mark as needing attention"}
                    onClick={() => reposition.mutate({ id: p.id, flagged: !p.flagged })}
                  >
                    <Flag className="h-3.5 w-3.5" />
                  </button>
                  <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    onClick={() => removePin.mutate({ id: p.id })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function SuggestedPinRow({
  number,
  draft,
  onDraftChange,
  selected,
  onSelect,
  onConfirm,
  onReject,
  currentAttachmentId,
}: {
  number: number;
  draft: Draft;
  onDraftChange: (next: Partial<Draft>) => void;
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
  onReject: () => void;
  currentAttachmentId: number;
}) {
  return (
    <div
      className={cn(
        "rounded border p-2 space-y-1.5 cursor-pointer",
        selected ? "border-violet-500 ring-1 ring-violet-300 bg-violet-50" : "border-violet-200 bg-white",
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 h-5 w-5 rounded-full bg-violet-500 text-white text-[10px] font-data shadow flex items-center justify-center">
          {number}
        </span>
        <div className="flex-1 min-w-0">
          <ItemPicker
            placeholder="Search or name this object…"
            value={draft.label}
            onQueryChange={(v) => onDraftChange({ label: v, item: draft.item ? null : draft.item })}
            onSelect={(sel) => onDraftChange({ label: sel.name, item: sel })}
            allowCreate
            onCreateNew={(name) => onDraftChange({ label: name, item: null })}
          />
        </div>
        <button
          className="shrink-0 h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          title="Reject"
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          className="shrink-0 h-6 w-6 flex items-center justify-center rounded text-emerald-700 hover:bg-emerald-100"
          title="Confirm"
          onClick={(e) => {
            e.stopPropagation();
            onConfirm();
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      </div>
      {draft.item && (
        <div className="ml-[26px]" onClick={(e) => e.stopPropagation()}>
          <LinkedItemChip
            item={draft.item}
            currentAttachmentId={currentAttachmentId}
            onUnlink={() => onDraftChange({ item: null })}
          />
        </div>
      )}
    </div>
  );
}
