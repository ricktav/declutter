import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Box } from "@/components/DetectObjects";
import { Loader2 } from "lucide-react";

type CropBox = { xPct: number; yPct: number; wPct: number; hPct: number };
type PhotoSize = "small" | "medium" | "big";
const SIZE_OPTIONS: { value: PhotoSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "big", label: "Big" },
];

function LibraryThumb({ storageKey, onPick }: { storageKey: string; onPick: () => void }) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  return (
    <button
      onClick={onPick}
      className="aspect-square rounded-lg overflow-hidden border border-border hover:border-primary bg-muted/40"
    >
      {url.data?.url && <img src={url.data.url} alt="" className="h-full w-full object-cover" />}
    </button>
  );
}

/** For an item with no photo of its own: browse photos that already came
 * through the inbox and crop the part that's this item, instead of only
 * being able to take a fresh one or upload a file. */
export function ChooseFromLibraryDialog({
  itemId,
  open,
  onClose,
}: {
  itemId: number;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const captures = trpc.inbox.list.useQuery(undefined, { enabled: open });
  const images = (captures.data ?? []).filter(
    (c): c is typeof c & { storageKey: string } => c.kind === "image" && !!c.storageKey,
  );

  const [pickedCaptureId, setPickedCaptureId] = useState<number | null>(null);
  const [sourcePhotoId, setSourcePhotoId] = useState<number | null>(null);
  const [box, setBox] = useState<CropBox>({ xPct: 50, yPct: 50, wPct: 40, hPct: 40 });
  const [photoSize, setPhotoSize] = useState<PhotoSize>("big");

  const ensure = trpc.photos.ensureForCapture.useMutation();
  const photoUrl = trpc.photos.get.useQuery(
    { id: sourcePhotoId ?? 0 },
    { enabled: sourcePhotoId != null },
  );
  const create = trpc.photos.createCutout.useMutation({
    onSuccess: () => {
      utils.photos.listForItem.invalidate({ itemId });
      utils.items.get.invalidate({ id: itemId });
      utils.items.listAll.invalidate();
      // the cutout adds a pin in the source photo: the Placement pane and badges change
      utils.items.placement.invalidate({ itemId });
      utils.items.placementSummary.invalidate();
      reset();
      onClose();
    },
  });

  const reset = () => {
    setPickedCaptureId(null);
    setSourcePhotoId(null);
    setBox({ xPct: 50, yPct: 50, wPct: 40, hPct: 40 });
    setPhotoSize("big");
  };

  const pick = async (captureId: number) => {
    setPickedCaptureId(captureId);
    const res = await ensure.mutateAsync({ captureId });
    setSourcePhotoId(res.photoId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="w-screen h-[100dvh] max-w-none sm:max-w-none rounded-none p-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose a photo from the library</DialogTitle>
        </DialogHeader>

        {!sourcePhotoId ? (
          <>
            <p className="text-[12px] text-muted-foreground -mt-2">
              Pick any photo that's already come through the inbox — crop the part that's this item.
            </p>
            {captures.isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> Loading photos…
              </div>
            ) : images.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-muted-foreground">No photos in the inbox yet.</div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {images.map((c) => (
                  <LibraryThumb key={c.id} storageKey={c.storageKey} onPick={() => pick(c.id)} />
                ))}
              </div>
            )}
            {ensure.isPending && pickedCaptureId != null && (
              <div className="text-[12px] text-muted-foreground mt-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> Opening photo…
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3 items-center">
            <p className="text-[12px] text-muted-foreground -mt-2">Drag to move, drag the corner to resize.</p>
            {photoUrl.data?.url && (
              <div className="relative inline-block select-none max-w-full">
                <img
                  src={photoUrl.data.url}
                  alt="source"
                  className="block max-h-[calc(100dvh-11rem)] max-w-full w-auto h-auto rounded touch-none"
                  draggable={false}
                />
                <Box box={box} color="#2d4a22" onChange={setBox} />
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="micro-label text-muted-foreground">Size</span>
              <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
                {SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPhotoSize(opt.value)}
                    className={`px-2.5 py-1 rounded text-[12px] font-medium ${
                      photoSize === opt.value ? "bg-white shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={reset} disabled={create.isPending}>
                Back
              </Button>
              <Button
                size="sm"
                onClick={() => create.mutate({ itemId, sourcePhotoId, box, photoSize })}
                disabled={create.isPending}
              >
                {create.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                Use this crop
              </Button>
            </div>
            {create.isError && <div className="text-[12px] text-destructive">{create.error.message}</div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
