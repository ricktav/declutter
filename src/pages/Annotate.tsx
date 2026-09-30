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
  MapPin,
  Flag,
} from "lucide-react";

type Draft = { label: string; item: { id: number; name: string } | null };

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

  const [pending, setPending] = useState<{ xPct: number; yPct: number } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingItem, setPendingItem] = useState<{ id: number; name: string } | null>(null);
  const [newItemArea, setNewItemArea] = useState<number | "">("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [detectInfo, setDetectInfo] = useState<string | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<number | null>(null);
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
    setSuggestionDrafts((prev) => ({ ...prev, [p.id]: { ...getDraft(p), ...next } }));
  };
  const confirmSuggestion = (p: Pin) => {
    const draft = getDraft(p);
    resolve.mutate({ id: p.id, confirm: true, label: draft.label, itemId: draft.item?.id ?? null });
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

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPending({
      xPct: ((e.clientX - rect.left) / rect.width) * 100,
      yPct: ((e.clientY - rect.top) / rect.height) * 100,
    });
    setPendingLabel("");
    setPendingItem(null);
    setEditingPinId(null);
  };

  const openEdit = (p: Pin) => {
    setPending(null);
    setEditingPinId(p.id);
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
    await addPin.mutateAsync({
      attachmentId: attId,
      xPct: pending.xPct,
      yPct: pending.yPct,
      label: pendingLabel.trim() || linkedItem?.name || "",
      itemId,
    });
    setPending(null);
  };

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
                className="w-full rounded cursor-crosshair"
                onClick={onImageClick}
                draggable={false}
              />
              <svg
                className="absolute inset-0 h-full w-full pointer-events-none"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {pins
                  .filter((p) => p.wPct != null && p.hPct != null)
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
                  return (
                    <div
                      key={`frame-${p.id}`}
                      data-suggestion-frame={p.id}
                      className="absolute cursor-pointer"
                      style={{
                        left: `${box.xPct - w / 2}%`,
                        top: `${box.yPct - h / 2}%`,
                        width: `${w}%`,
                        height: `${h}%`,
                      }}
                      onMouseEnter={() => setHoveredSuggestionId(p.id)}
                      onMouseLeave={() => setHoveredSuggestionId((cur) => (cur === p.id ? null : cur))}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedSuggestionId(p.id);
                      }}
                    >
                      {showIcons && (
                        <div className="absolute -top-2.5 -right-2.5 flex gap-1 z-10">
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
                  );
                })}
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
                    {p.label || p.itemName || "untitled"}
                    {p.itemName && p.label && p.itemName !== p.label ? ` → ${p.itemName}` : ""}
                  </div>
                </div>
                );
              })}
              {pending && (
                <div
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${pending.xPct}%`, top: `${pending.yPct}%` }}
                >
                  <MapPin className="h-6 w-6 text-primary animate-bounce" />
                </div>
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
                <div className="text-[12px] rounded bg-accent px-2 py-1 flex items-center gap-1">
                  linked: <b>{editItem.name}</b>
                  <button className="ml-auto" onClick={() => setEditItem(null)}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
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
                      reposition.mutate({ id: editingPin.id, label: editLabel.trim(), itemId: editItem?.id ?? null });
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
              <div className="micro-label text-primary">New pin</div>
              <ItemPicker
                placeholder="Search or name this object…"
                value={pendingLabel}
                onQueryChange={(v) => {
                  setPendingLabel(v);
                  if (pendingItem) setPendingItem(null);
                }}
                onSelect={(item) => {
                  setPendingItem(item);
                  setPendingLabel(item.name);
                  savePending(item);
                }}
                allowCreate
                onCreateNew={(name) => {
                  setPendingLabel(name);
                  setPendingItem(null);
                }}
                autoFocus
              />
              {pendingItem && (
                <div className="text-[12px] rounded bg-accent px-2 py-1 flex items-center gap-1">
                  linked: <b>{pendingItem.name}</b>
                  <button className="ml-auto" onClick={() => setPendingItem(null)}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
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
                    {p.label || <span className="text-muted-foreground">untitled</span>}
                  </span>
                  {p.itemId && p.itemName ? (
                    <Link to={`/items/${p.itemId}`} className="text-[11px] text-primary hover:underline truncate max-w-24">
                      {p.itemName}
                    </Link>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">unlinked</span>
                  )}
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
}: {
  number: number;
  draft: Draft;
  onDraftChange: (next: Partial<Draft>) => void;
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
  onReject: () => void;
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
        <div className="text-[11px] rounded bg-accent px-2 py-1 flex items-center gap-1 ml-[26px]">
          linked: <b>{draft.item.name}</b>
          <button
            className="ml-auto"
            onClick={(e) => {
              e.stopPropagation();
              onDraftChange({ item: null });
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
