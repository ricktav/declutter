import { useEffect, useState } from "react";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { Box } from "@/components/DetectObjects";
import { Button } from "@/components/ui/button";
import { trpc } from "@/providers/trpc";
import { Loader2 } from "lucide-react";

type CropBox = { xPct: number; yPct: number; wPct: number; hPct: number };

const DEFAULT_BOX: CropBox = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 };

function boxesEqual(a: CropBox, b: CropBox) {
  return a.xPct === b.xPct && a.yPct === b.yPct && a.wPct === b.wPct && a.hPct === b.hPct;
}

/**
 * Zoom overlay for a Thing's photo. Cutouts show the original source with
 * this Thing's crop frame on it so the frame can be resized in place;
 * photos with no source just enlarge. Double-click the photo to close;
 * double-click empty space to Fit.
 */
export function PhotoCropZoom({
  photoId,
  storageKey,
  title,
  onClose,
}: {
  photoId: number;
  storageKey: string | null;
  title?: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const source = trpc.photos.sourcePhoto.useQuery({ photoId });
  const fallback = trpc.photos.url.useQuery(
    { key: storageKey ?? "" },
    { enabled: !!storageKey && source.data?.available !== true },
  );
  const [box, setBox] = useState<CropBox>(DEFAULT_BOX);
  const [savedBox, setSavedBox] = useState<CropBox | null>(null);

  useEffect(() => {
    if (!source.data?.available) return;
    const next = source.data.cropBox ?? DEFAULT_BOX;
    setBox(next);
    setSavedBox(source.data.cropBox);
  }, [source.data]);

  const recrop = trpc.photos.recrop.useMutation({
    onSuccess: () => {
      setSavedBox(box);
      utils.photos.listForItem.invalidate();
      utils.photos.get.invalidate();
      utils.photos.sourcePhoto.invalidate({ photoId });
      utils.items.get.invalidate();
      utils.items.placement.invalidate();
    },
  });

  const canCrop = source.data?.available === true;
  const url = source.data?.available ? (source.data.url ?? null) : (fallback.data?.url ?? null);
  const dirty = canCrop && (savedBox == null || !boxesEqual(box, savedBox));

  return (
    <ZoomOverlay
      open
      onClose={onClose}
      title={title}
      toolbarExtra={
        canCrop ? (
          <Button
            size="sm"
            className="h-8 text-[12px]"
            disabled={!dirty || recrop.isPending}
            onClick={() => recrop.mutate({ photoId, box })}
          >
            {recrop.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save crop
          </Button>
        ) : undefined
      }
    >
      {source.isLoading || (!url && fallback.isLoading) ? (
        <div className="text-[13px] text-white/70">
          <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />
          Loading photo…
        </div>
      ) : url ? (
        <div className="relative inline-block max-w-full max-h-full select-none">
          <img
            src={url}
            alt=""
            draggable={false}
            className="block max-w-[90vw] max-h-[80vh] w-auto h-auto rounded"
          />
          {canCrop && <Box box={box} color="#d2ff00" onChange={setBox} />}
        </div>
      ) : (
        <div className="text-[13px] text-white/70">Photo unavailable</div>
      )}
    </ZoomOverlay>
  );
}
