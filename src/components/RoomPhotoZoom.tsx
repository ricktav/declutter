import { useState } from "react";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { ItemPicker } from "@/components/ItemPicker";
import { Button } from "@/components/ui/button";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";

/** Lightbox for a room photo: pan/zoom, then Pin to link a Thing or type a label. */
export function RoomPhotoZoom({
  url,
  photoId,
  title,
  onClose,
}: {
  url: string;
  photoId: number;
  title?: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const pins = trpc.pins.listForPhoto.useQuery({ photoId });
  const addPin = trpc.pins.add.useMutation({
    onSuccess: () => {
      utils.pins.listForPhoto.invalidate({ photoId });
      utils.items.placementSummary.invalidate();
    },
  });
  const [placeMode, setPlaceMode] = useState(false);
  const [pending, setPending] = useState<{ xPct: number; yPct: number } | null>(null);
  const [label, setLabel] = useState("");
  const [item, setItem] = useState<{ id: number; name: string } | null>(null);

  const save = () => {
    if (!pending) return;
    addPin.mutate(
      {
        photoId,
        xPct: pending.xPct,
        yPct: pending.yPct,
        label: item?.name ?? label.trim(),
        itemId: item?.id,
      },
      {
        onSuccess: () => {
          setPending(null);
          setLabel("");
          setItem(null);
          setPlaceMode(false);
        },
      },
    );
  };

  return (
    <ZoomOverlay
      open
      onClose={onClose}
      title={title}
      placeMode={placeMode && pending == null}
      onPlace={(pct) => {
        setPending(pct);
        setPlaceMode(false);
      }}
      toolbarExtra={
        <div className="flex items-center gap-2 mr-2 min-w-0">
          <button
            type="button"
            className={cn(
              "h-8 px-2 rounded-md text-[12px] text-white/90 hover:bg-white/15",
              placeMode && "bg-white/20",
            )}
            onClick={() => {
              setPlaceMode((p) => !p);
              setPending(null);
            }}
          >
            {placeMode ? "Click the photo to pin" : "Pin"}
          </button>
          {pending && (
            <div className="flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 min-w-0">
              <div className="w-48">
                <ItemPicker
                  autoFocus
                  placeholder="link a Thing…"
                  onSelect={(sel) => {
                    setItem(sel);
                    setLabel(sel.name);
                  }}
                />
              </div>
              <input
                className="w-28 rounded border border-white/20 bg-transparent px-1.5 py-1 text-[12px] text-white"
                placeholder="or label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
              <Button size="sm" className="h-7 text-[11px]" disabled={addPin.isPending} onClick={save}>
                Save pin
              </Button>
              <button type="button" className="text-[11px] text-white/70" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      }
    >
      <div data-pin-canvas className="relative inline-block max-w-full max-h-full">
        <img src={url} alt="" draggable={false} className="max-w-full max-h-[80vh] object-contain rounded" />
        {(pins.data ?? [])
          .filter((p) => p.status === "confirmed")
          .map((p) => (
            <span
              key={p.id}
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-primary shadow"
              style={{ left: `${p.xPct}%`, top: `${p.yPct}%` }}
              title={p.itemName ?? p.label ?? "pin"}
            />
          ))}
        {pending && (
          <span
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-amber-400 shadow"
            style={{ left: `${pending.xPct}%`, top: `${pending.yPct}%` }}
          />
        )}
      </div>
    </ZoomOverlay>
  );
}
