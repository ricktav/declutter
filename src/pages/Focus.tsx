import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { StoredImage } from "@/components/Thumb";
import { AreaPicker } from "@/components/AreaPicker";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLastRoomId } from "@/hooks/use-last-room";
import { setLastRoomId } from "@/lib/lastRoom";
import { DECISIONS } from "@/lib/decisions";
import { cn } from "@/lib/utils";
import type { ItemDecision } from "@db/schema";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { Check, Loader2, MapPin, ScanSearch, Sparkles, Trash2, Undo2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Pin = inferRouterOutputs<AppRouter>["pins"]["listForPhoto"][number];
type RoomPhoto = inferRouterOutputs<AppRouter>["photos"]["roomPhotos"][number];
type CropBox = { xPct: number; yPct: number; wPct: number; hPct: number };

function boxOf(p: { xPct: number; yPct: number; wPct?: number | null; hPct?: number | null }): CropBox {
  return { xPct: p.xPct, yPct: p.yPct, wPct: p.wPct && p.wPct > 0 ? p.wPct : 12, hPct: p.hPct && p.hPct > 0 ? p.hPct : 12 };
}

function isWholeScenePin(p: { wPct?: number | null; hPct?: number | null }) {
  return p.wPct === 0 && p.hPct === 0;
}

function frameLabel(p: Pin, num: number) {
  return p.itemName || p.label || `Frame ${num}`;
}

function isUnhandledItem(it: { decision: ItemDecision | null; verificationStatus: string; status: string }) {
  return it.status === "active" && it.verificationStatus !== "rejected" && it.decision == null;
}

type Sel = { kind: "pin"; pinId: number } | { kind: "item"; itemId: number };

/** A stored photo at its own aspect ratio so percent frames land on the picture. */
function FramedRoomPhoto({
  storageKey,
  children,
  onDrawBox,
}: {
  storageKey: string;
  children?: ReactNode;
  onDrawBox?: (box: CropBox) => void;
}) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  const [ratio, setRatio] = useState(4 / 3);
  const draw = useRef<{ xPct: number; yPct: number } | null>(null);
  const [pending, setPending] = useState<CropBox | null>(null);
  const host = useRef<HTMLDivElement>(null);

  const pt = (e: React.PointerEvent) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      xPct: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
      yPct: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
    };
  };

  return (
    <div className="flex w-full justify-center">
      <div
        ref={host}
        className="relative overflow-hidden rounded-xl bg-muted touch-none"
        style={{ aspectRatio: String(ratio), width: `min(100%, calc(62dvh * ${ratio}))` }}
        onPointerDown={(e) => {
          if (!onDrawBox || e.button !== 0) return;
          const p = pt(e);
          if (!p) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          draw.current = p;
          setPending({ ...p, wPct: 0, hPct: 0 });
        }}
        onPointerMove={(e) => {
          const start = draw.current;
          if (!start) return;
          const p = pt(e);
          if (!p) return;
          const left = Math.min(start.xPct, p.xPct);
          const right = Math.max(start.xPct, p.xPct);
          const top = Math.min(start.yPct, p.yPct);
          const bottom = Math.max(start.yPct, p.yPct);
          setPending({ xPct: (left + right) / 2, yPct: (top + bottom) / 2, wPct: right - left, hPct: bottom - top });
        }}
        onPointerUp={() => {
          const box = pending;
          draw.current = null;
          setPending(null);
          if (box && onDrawBox && box.wPct >= 3 && box.hPct >= 3) onDrawBox(box);
        }}
      >
        {url.data?.url && (
          <img
            src={url.data.url}
            alt=""
            className="absolute inset-0 h-full w-full pointer-events-none"
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) setRatio(w / h);
            }}
          />
        )}
        {children}
        {pending && pending.wPct > 0 && (
          <div
            className="absolute border-2 border-dashed border-hb-lime bg-hb-lime/10 pointer-events-none"
            style={{
              left: `${pending.xPct - pending.wPct / 2}%`,
              top: `${pending.yPct - pending.hPct / 2}%`,
              width: `${pending.wPct}%`,
              height: `${pending.hPct}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

function DecisionBar({
  current,
  disabled,
  onPick,
}: {
  current?: ItemDecision | null;
  disabled?: boolean;
  onPick: (d: ItemDecision) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {DECISIONS.map((d) => (
        <button
          key={d.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(d.key)}
          className={cn(
            "rounded-xl border-2 py-2.5 font-data text-[13px] font-semibold disabled:opacity-40",
            d.key === "keep" && "col-span-2",
          )}
          style={{
            color: current === d.key ? "#fff" : d.color,
            borderColor: d.color,
            background: current === d.key ? d.color : `color-mix(in srgb, ${d.color} 8%, transparent)`,
          }}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

function FocusSheetBody({
  sel,
  pin,
  num,
  roomId,
  photoId,
  onClose,
  onHide,
}: {
  sel: Sel;
  pin: Pin | null;
  num: number | null;
  roomId: number | null;
  photoId: number | null;
  onClose: () => void;
  onHide: () => void;
}) {
  const utils = trpc.useUtils();
  const itemId = sel.kind === "item" ? sel.itemId : (pin?.itemId ?? null);
  const item = trpc.items.get.useQuery({ id: itemId ?? 0 }, { enabled: itemId != null });
  const [name, setName] = useState("");
  const [areaId, setAreaId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [placeHere, setPlaceHere] = useState(true);
  const [draftDecision, setDraftDecision] = useState<ItemDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    const key = sel.kind === "pin" ? `pin:${sel.pinId}:${itemId ?? 0}` : `item:${sel.itemId}`;
    if (seeded.current === key) return;
    if (itemId != null && item.data) {
      seeded.current = key;
      setName(item.data.name);
      setAreaId(item.data.areaId);
      setNote(item.data.description ?? "");
      setPlaceHere(roomId != null && item.data.roomId === roomId);
      setDraftDecision(item.data.decision ?? null);
      setError(null);
    } else if (itemId == null && pin) {
      seeded.current = key;
      setName(pin.label || (num != null ? `Frame ${num}` : ""));
      setAreaId(null);
      setNote("");
      setPlaceHere(roomId != null);
      setDraftDecision(null);
      setError(null);
    }
  }, [sel, pin, item.data, itemId, num, roomId]);

  const refresh = () => {
    utils.pins.listForPhoto.invalidate();
    utils.items.listAll.invalidate();
    utils.items.get.invalidate();
    utils.photos.roomPhotos.invalidate();
  };

  const create = trpc.items.create.useMutation({ onError: (e) => setError(e.message) });
  const update = trpc.items.update.useMutation({ onError: (e) => setError(e.message) });
  const setDecision = trpc.items.setDecision.useMutation({ onError: (e) => setError(e.message) });
  const pinUpdate = trpc.pins.update.useMutation({ onError: (e) => setError(e.message) });
  const cutout = trpc.photos.createCutout.useMutation({ onError: (e) => setError(e.message) });
  const busy = create.isPending || update.isPending || setDecision.isPending || pinUpdate.isPending || cutout.isPending;

  const admit = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const created = await create.mutateAsync({
      ...(areaId != null ? { areaId } : {}),
      name: trimmed,
      description: note.trim() || undefined,
      roomId: placeHere ? roomId : null,
      suggestLinks: false,
    });
    if (pin) {
      await pinUpdate.mutateAsync({ id: pin.id, itemId: created.id, label: trimmed });
      if (photoId != null) {
        const box = boxOf(pin);
        try {
          await cutout.mutateAsync({ itemId: created.id, sourcePhotoId: photoId, box });
        } catch {
          // pin is already linked; a cutout is extra
        }
      }
    }
    if (draftDecision) await setDecision.mutateAsync({ id: created.id, decision: draftDecision });
    if (placeHere && roomId != null) setLastRoomId(roomId);
    refresh();
    onClose();
  };

  const saveExisting = async () => {
    if (itemId == null) return;
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    await update.mutateAsync({
      id: itemId,
      name: trimmed,
      description: note.trim() ? note.trim() : null,
      roomId: placeHere && roomId != null ? roomId : undefined,
      ...(areaId != null ? { areaId } : {}),
    });
    if (pin) await pinUpdate.mutateAsync({ id: pin.id, label: trimmed, itemId });
    if (placeHere && roomId != null) setLastRoomId(roomId);
    refresh();
  };

  const pickDecision = async (d: ItemDecision) => {
    setDraftDecision(d);
    if (itemId == null) return;
    setError(null);
    await setDecision.mutateAsync({ id: itemId, decision: d });
    refresh();
  };

  const existing = itemId != null ? item.data : null;
  const title = num != null ? `Frame ${num}` : "Thing";

  return (
    <>
      <SheetHeader className="px-0 pt-0">
        <SheetTitle className="font-data text-[16px]">{title}</SheetTitle>
        <SheetDescription className="text-[12px]">
          {existing ? "Thin sheet — full Thing page is one tap away." : "Admit this frame as a Thing. Only the name is required; without a kind it goes to Things. Place is optional."}
        </SheetDescription>
      </SheetHeader>

      <label className="block text-[12px] font-medium">
        Name
        <input
          className="mt-1 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={num != null ? `Frame ${num}` : "Name"}
        />
      </label>

      <label className="block text-[12px] font-medium">
        Kind
        <div className="mt-1">
          <AreaPicker value={areaId} onChange={setAreaId} placeholder="Things (optional)" />
        </div>
      </label>

      <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={placeHere}
            onChange={(e) => setPlaceHere(e.target.checked)}
            disabled={roomId == null}
          />
          <span>
            <span className="font-medium">This Place</span>
            <span className="block text-[12px] text-muted-foreground">
              {roomId == null
                ? "Pick a Place first."
                : existing?.roomId === roomId
                  ? "Already in this Place."
                  : "Set the Thing’s Place to the one you are looking at."}
            </span>
          </span>
        </label>
      </div>

      <label className="block text-[12px] font-medium">
        Short note
        <textarea
          className="mt-1 w-full min-h-[56px] rounded-md border border-input bg-white px-2 py-1.5 text-[13px] resize-y"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional"
        />
      </label>

      <div>
        <div className="micro-label text-muted-foreground mb-1.5">Decision</div>
        <DecisionBar current={draftDecision} disabled={busy} onPick={pickDecision} />
        {itemId == null && (
          <p className="mt-1 text-[11px] text-muted-foreground">Saved when you admit the frame.</p>
        )}
      </div>

      {error && <div className="text-[12px] text-destructive">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {itemId == null ? (
          <Button size="sm" disabled={busy} onClick={() => void admit()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Admit
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void saveExisting()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          disabled={busy}
          onClick={onHide}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {pin ? (itemId != null ? "Hide from photo" : "Discard") : "Hide from list"}
        </Button>
        {itemId != null && (
          <Link to={`/items/${itemId}`} className="text-[12px] text-primary hover:underline ml-auto">
            Full Thing →
          </Link>
        )}
      </div>
    </>
  );
}

export default function FocusPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const rooms = trpc.rooms.list.useQuery();
  const lastRoomId = useLastRoomId();
  const roomIdParam = searchParams.get("roomId");
  const roomFromUrl = roomIdParam && Number.isFinite(Number(roomIdParam)) ? Number(roomIdParam) : null;

  const roomId = useMemo(() => {
    const list = rooms.data ?? [];
    if (list.length === 0) return null;
    if (roomFromUrl != null && list.some((r) => r.id === roomFromUrl)) return roomFromUrl;
    if (lastRoomId != null && list.some((r) => r.id === lastRoomId)) return lastRoomId;
    return list[0].id;
  }, [rooms.data, roomFromUrl, lastRoomId]);

  const [photoId, setPhotoId] = useState<number | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [listFilter, setListFilter] = useState<"focus" | "all">("focus");
  const [hiddenItemIds, setHiddenItemIds] = useState<number[]>([]);
  const [undo, setUndo] = useState<
    | { kind: "pin"; pinId: number; status: "suggested" | "confirmed"; label: string }
    | { kind: "item"; itemId: number; label: string }
    | null
  >(null);
  const [confirmTrash, setConfirmTrash] = useState<
    | { kind: "pin"; pin: Pin; num: number }
    | { kind: "item"; itemId: number; name: string }
    | null
  >(null);

  const selectRoom = (id: number) => {
    setLastRoomId(id);
    const next = new URLSearchParams(searchParams);
    next.set("roomId", String(id));
    setSearchParams(next, { replace: true });
    setPhotoId(null);
    setSel(null);
  };

  const roomPhotos = trpc.photos.roomPhotos.useQuery({ roomId: roomId ?? 0 }, { enabled: roomId != null });
  const canvases = useMemo(() => {
    const all = roomPhotos.data ?? [];
    const full = all.filter((p) => !p.isCrop);
    return full.length ? full : all;
  }, [roomPhotos.data]);

  const selectedPhoto: RoomPhoto | undefined = canvases.find((p) => p.photoId === photoId) ?? canvases[0];
  const activePhotoId = selectedPhoto?.photoId ?? null;

  const pinsQ = trpc.pins.listForPhoto.useQuery({ photoId: activePhotoId ?? 0 }, { enabled: activePhotoId != null });
  const houseItems = trpc.items.listAll.useQuery({ includeArchived: false });

  const frames = useMemo(() => {
    const pins = [...(pinsQ.data ?? [])].filter((p) => !isWholeScenePin(p)).sort((a, b) => a.id - b.id);
    return pins.map((p, i) => ({ pin: p, num: i + 1, box: boxOf(p) }));
  }, [pinsQ.data]);

  const itemsById = useMemo(() => new Map((houseItems.data ?? []).map((it) => [it.id, it])), [houseItems.data]);

  const selectedPin = sel?.kind === "pin" ? (frames.find((f) => f.pin.id === sel.pinId)?.pin ?? null) : null;
  const selectedNum = sel?.kind === "pin" ? (frames.find((f) => f.pin.id === sel.pinId)?.num ?? null) : null;

  const pinnedItemIds = useMemo(() => new Set(frames.map((f) => f.pin.itemId).filter((id): id is number => id != null)), [frames]);
  const extraItems = (houseItems.data ?? []).filter(
    (it) =>
      it.roomId === roomId &&
      it.verificationStatus !== "rejected" &&
      !pinnedItemIds.has(it.id) &&
      !hiddenItemIds.includes(it.id),
  );

  const frameUnhandled = (f: (typeof frames)[number]) => {
    if (!f.pin.itemId) return true;
    const it = itemsById.get(f.pin.itemId);
    if (!it) return false;
    return isUnhandledItem(it);
  };

  const visibleFrames = listFilter === "focus" ? frames.filter(frameUnhandled) : frames;
  const visibleExtra = listFilter === "focus" ? extraItems.filter(isUnhandledItem) : extraItems;

  const utils = trpc.useUtils();
  const addPin = trpc.pins.add.useMutation({
    onSuccess: (r) => {
      utils.pins.listForPhoto.invalidate();
      utils.photos.roomPhotos.invalidate();
      setSel({ kind: "pin", pinId: r.id });
    },
  });
  const detect = trpc.pins.detect.useMutation({
    onSuccess: () => {
      utils.pins.listForPhoto.invalidate();
      utils.photos.roomPhotos.invalidate();
    },
  });
  const dismissPin = trpc.pins.resolve.useMutation({
    onSuccess: () => {
      utils.pins.listForPhoto.invalidate();
      utils.photos.roomPhotos.invalidate();
    },
  });
  const restorePin = trpc.pins.update.useMutation({
    onSuccess: () => {
      utils.pins.listForPhoto.invalidate();
      utils.photos.roomPhotos.invalidate();
    },
  });

  const pinStatusForUndo = (p: Pin): "suggested" | "confirmed" =>
    p.status === "suggested" ? "suggested" : "confirmed";

  const hidePin = (pin: Pin, num: number) => {
    const label = frameLabel(pin, num);
    dismissPin.mutate(
      { id: pin.id, confirm: false },
      {
        onSuccess: () => {
          if (sel?.kind === "pin" && sel.pinId === pin.id) setSel(null);
          setUndo({ kind: "pin", pinId: pin.id, status: pinStatusForUndo(pin), label });
        },
      },
    );
  };

  const hideExtraItem = (itemId: number, name: string) => {
    setHiddenItemIds((ids) => (ids.includes(itemId) ? ids : [...ids, itemId]));
    if (sel?.kind === "item" && sel.itemId === itemId) setSel(null);
    setUndo({ kind: "item", itemId, label: name });
  };

  const requestHidePin = (pin: Pin, num: number) => {
    if (pin.itemId) setConfirmTrash({ kind: "pin", pin, num });
    else hidePin(pin, num);
  };

  const requestHideExtra = (itemId: number, name: string) => {
    setConfirmTrash({ kind: "item", itemId, name });
  };

  const undoHide = () => {
    if (!undo) return;
    if (undo.kind === "pin") {
      restorePin.mutate({ id: undo.pinId, status: undo.status });
    } else {
      setHiddenItemIds((ids) => ids.filter((id) => id !== undo.itemId));
    }
    setUndo(null);
  };

  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(t);
  }, [undo]);

  useEffect(() => {
    setHiddenItemIds([]);
    setUndo(null);
    setConfirmTrash(null);
  }, [roomId, activePhotoId]);

  const roomName = rooms.data?.find((r) => r.id === roomId)?.name ?? "this Place";
  const unhandledCount =
    frames.filter(frameUnhandled).length + extraItems.filter(isUnhandledItem).length;

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-5 md:py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Focus</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Place first: pick one, read numbered frames on a Photo, admit or decide in the thin sheet.
          </p>
        </div>
        {unhandledCount > 0 && (
          <div className="font-data text-[12px] rounded-full bg-hb-lime text-hb-charcoal px-2.5 py-1 shrink-0">
            {unhandledCount} unhandled
          </div>
        )}
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {(rooms.data ?? []).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRoom(r.id)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-[12px]",
              roomId === r.id ? "border-primary bg-primary/10" : "border-border bg-white",
            )}
          >
            {r.name}
            <span className="font-data opacity-60 ml-1">{r.itemCount}</span>
          </button>
        ))}
        {rooms.data?.length === 0 && (
          <div className="text-[13px] text-muted-foreground">No Places in this house yet. Create one in Places, or switch house.</div>
        )}
      </div>

      {roomId == null ? null : canvases.length === 0 && !roomPhotos.isLoading ? (
        <div className="mt-8 rounded-lg border border-dashed border-border p-6 text-[13px] text-muted-foreground">
          No photos for {roomName} yet. File a snap in Sort, or open Photos / Annotate in Advanced.
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)] gap-4 items-start">
          <div className="space-y-3">
            {canvases.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {canvases.map((p) => (
                  <button
                    key={p.photoId}
                    type="button"
                    onClick={() => {
                      setPhotoId(p.photoId);
                      setSel(null);
                    }}
                    className={cn(
                      "shrink-0 w-16 h-16 rounded-md overflow-hidden border-2",
                      activePhotoId === p.photoId ? "border-primary" : "border-transparent",
                    )}
                    title={p.title ?? `Photo ${p.photoId}`}
                  >
                    <StoredImage storageKey={p.storageKey} className="h-full w-full object-cover" fallback={<div className="h-full w-full bg-muted" />} />
                  </button>
                ))}
              </div>
            )}

            {selectedPhoto && (
              <FramedRoomPhoto
                storageKey={selectedPhoto.storageKey}
                onDrawBox={(box) => {
                  if (activePhotoId == null) return;
                  addPin.mutate({
                    photoId: activePhotoId,
                    ...box,
                    label: `Frame ${frames.length + 1}`,
                  });
                }}
              >
                {frames.map((f) => {
                  const color = f.pin.itemAreaColor ?? (f.pin.itemId ? "#5b8c5a" : "#282c20");
                  const on = sel?.kind === "pin" && sel.pinId === f.pin.id;
                  return (
                    <button
                      key={f.pin.id}
                      type="button"
                      className="absolute border-2 rounded-sm"
                      style={{
                        left: `${f.box.xPct - f.box.wPct / 2}%`,
                        top: `${f.box.yPct - f.box.hPct / 2}%`,
                        width: `${f.box.wPct}%`,
                        height: `${f.box.hPct}%`,
                        borderColor: on ? "#d2ff00" : color,
                        background: on ? "#d2ff0022" : `${color}22`,
                        borderStyle: f.pin.itemId ? "solid" : "dashed",
                        zIndex: on ? 5 : 1,
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSel({ kind: "pin", pinId: f.pin.id });
                      }}
                    >
                      <span
                        className="absolute -top-2.5 -left-2.5 h-5 min-w-5 px-1 rounded-full text-[10px] font-data font-semibold flex items-center justify-center text-white shadow"
                        style={{ background: on ? "#282c20" : color }}
                      >
                        {f.num}
                      </span>
                    </button>
                  );
                })}
              </FramedRoomPhoto>
            )}

            {selectedPhoto && selectedPhoto.linkedItems.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedPhoto.linkedItems.map((it) => (
                  <Link
                    key={it.id}
                    to={`/items/${it.id}`}
                    className="rounded-full border border-border bg-white px-2.5 py-0.5 text-[12px] hover:border-primary"
                  >
                    {it.name}
                  </Link>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <ScanSearch className="h-3.5 w-3.5" />
              Draw a box on the photo to add a frame.
              {activePhotoId != null && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[12px] ml-auto"
                  disabled={detect.isPending}
                  onClick={() => detect.mutate({ photoId: activePhotoId })}
                >
                  {detect.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Find frames
                </Button>
              )}
            </div>
            {detect.isError && <div className="text-[12px] text-destructive">{detect.error.message}</div>}
            {addPin.isError && <div className="text-[12px] text-destructive">{addPin.error.message}</div>}
          </div>

          <div className="rounded-lg border border-border bg-white">
            <div className="flex items-center gap-1 p-2 border-b border-border">
              {(["focus", "all"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setListFilter(k)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] capitalize",
                    listFilter === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {k === "focus" ? "Unhandled" : "Show all"}
                </button>
              ))}
            </div>
            <div className="max-h-[55dvh] overflow-y-auto divide-y divide-border">
              {visibleFrames.map((f) => {
                const on = sel?.kind === "pin" && sel.pinId === f.pin.id;
                const it = f.pin.itemId ? itemsById.get(f.pin.itemId) : undefined;
                const open = frameUnhandled(f);
                return (
                  <div
                    key={f.pin.id}
                    className={cn("flex items-center gap-1 pr-1", on ? "bg-accent" : "hover:bg-muted/60")}
                  >
                    <button
                      type="button"
                      onClick={() => setSel({ kind: "pin", pinId: f.pin.id })}
                      className="min-w-0 flex-1 text-left px-3 py-2 flex items-center gap-2"
                    >
                      <span className="font-data h-6 w-6 rounded-full bg-hb-charcoal text-white text-[11px] flex items-center justify-center shrink-0">
                        {f.num}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] truncate">{frameLabel(f.pin, f.num)}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {open ? "needs admit or decision" : it?.decision ?? "handled"}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="h-7 w-7 shrink-0 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title={f.pin.itemId ? "Hide from this photo" : "Discard this detection"}
                      aria-label={f.pin.itemId ? `Hide ${frameLabel(f.pin, f.num)} from this photo` : `Discard ${frameLabel(f.pin, f.num)}`}
                      onClick={() => requestHidePin(f.pin, f.num)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mx-auto" />
                    </button>
                  </div>
                );
              })}
              {visibleExtra.length > 0 && (
                <div className="px-3 py-1.5 micro-label text-muted-foreground bg-muted/40">Other Things in this Place</div>
              )}
              {visibleExtra.map((it) => {
                const on = sel?.kind === "item" && sel.itemId === it.id;
                return (
                  <div
                    key={it.id}
                    className={cn("flex items-center gap-1 pr-1", on ? "bg-accent" : "hover:bg-muted/60")}
                  >
                    <button
                      type="button"
                      onClick={() => setSel({ kind: "item", itemId: it.id })}
                      className="min-w-0 flex-1 text-left px-3 py-2 flex items-center gap-2"
                    >
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] truncate">{it.name}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {it.areaName ?? "no kind"} · {it.decision ?? "no decision"}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="h-7 w-7 shrink-0 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      title="Hide from this list"
                      aria-label={`Hide ${it.name} from this list`}
                      onClick={() => requestHideExtra(it.id, it.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mx-auto" />
                    </button>
                  </div>
                );
              })}
              {visibleFrames.length === 0 && visibleExtra.length === 0 && (
                <div className="px-3 py-6 text-[13px] text-muted-foreground">
                  {listFilter === "focus" ? "Nothing unhandled in this photo or room." : "No frames yet — draw a box on the photo. Show all also lists handled Things."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <Sheet open={sel != null} onOpenChange={(o) => !o && setSel(null)}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn("overflow-y-auto", isMobile ? "max-h-[88dvh] w-full sm:max-w-none" : "sm:max-w-md")}
        >
          {sel && (
            <div className="space-y-3 p-1 pb-6">
              <FocusSheetBody
                sel={sel}
                pin={selectedPin}
                num={selectedNum}
                roomId={roomId}
                photoId={activePhotoId}
                onClose={() => setSel(null)}
                onHide={() => {
                  if (sel.kind === "pin" && selectedPin) {
                    requestHidePin(selectedPin, selectedNum ?? 0);
                  } else if (sel.kind === "item") {
                    const name = houseItems.data?.find((it) => it.id === sel.itemId)?.name ?? "Thing";
                    requestHideExtra(sel.itemId, name);
                  }
                }}
              />
              {sel.kind === "item" && (
                <button type="button" className="text-[12px] text-muted-foreground hover:underline" onClick={() => navigate(`/items/${sel.itemId}`)}>
                  Open full Thing page
                </button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmTrash != null} onOpenChange={(o) => !o && setConfirmTrash(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTrash?.kind === "pin" ? "Hide from this photo?" : "Hide from this list?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTrash?.kind === "pin"
                ? `${frameLabel(confirmTrash.pin, confirmTrash.num)} stays in the inventory. This only hides the frame on this photo — the Thing, its photos and files are not deleted.`
                : `${confirmTrash?.kind === "item" ? confirmTrash.name : "This Thing"} stays in the Place. This only hides it from the Focus list.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirmTrash?.kind === "pin") hidePin(confirmTrash.pin, confirmTrash.num);
                else if (confirmTrash?.kind === "item") hideExtraItem(confirmTrash.itemId, confirmTrash.name);
                setConfirmTrash(null);
              }}
            >
              Hide
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {undo && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-white px-3 py-2 text-[13px] shadow-md"
        >
          <span className="max-w-[16rem] truncate">Hidden “{undo.label}”</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-data text-[12px] text-primary hover:underline"
            onClick={undoHide}
          >
            <Undo2 className="h-3.5 w-3.5" />
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
