import { useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CropDialog } from "@/components/CropDialog";
import { Loader2 } from "lucide-react";
import { invalidatePhotoChange, usePhotoFromTarget } from "@/hooks/use-photo-from-target";

import { DEFAULT_CROP_BOX } from "@/lib/cropBox";
type PhotoSize = "small" | "medium" | "big";
const SIZE_OPTIONS: { value: PhotoSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "big", label: "Big" },
];

function PhotoSizeSelect({ value, onChange }: { value: PhotoSize; onChange: (v: PhotoSize) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="micro-label text-muted-foreground">Size</span>
      <div className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
        {SIZE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 rounded text-[12px] font-medium ${
              value === opt.value ? "bg-white shadow-sm" : "text-muted-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

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
  const [photoSize, setPhotoSize] = useState<PhotoSize>("big");

  const photoFrom = usePhotoFromTarget();
  const photoUrl = trpc.photos.get.useQuery(
    { id: sourcePhotoId ?? 0 },
    { enabled: sourcePhotoId != null },
  );
  const create = trpc.photos.createCutout.useMutation({
    onSuccess: () => {
      // the cutout adds a pin in the source photo: the Placement pane and badges change
      invalidatePhotoChange(utils, { itemIds: [itemId] });
      reset();
      onClose();
    },
  });

  const reset = () => {
    setPickedCaptureId(null);
    setSourcePhotoId(null);
    setPhotoSize("big");
  };

  const pick = async (captureId: number) => {
    setPickedCaptureId(captureId);
    setSourcePhotoId(await photoFrom.resolve({ source: "capture", captureId }));
  };

  const closeAll = () => {
    reset();
    onClose();
  };

  return (
    <>
      <Dialog open={open && !sourcePhotoId} onOpenChange={(o) => !o && closeAll()}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>Choose a photo from the library</DialogTitle>
          </DialogHeader>
          <p className="text-[12px] text-muted-foreground -mt-2">
            Pick any photo that's already come through Sort — crop the part that's this Thing.
          </p>
          {captures.isLoading ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> Loading photos…
            </div>
          ) : images.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-muted-foreground">No snaps in Sort yet.</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {images.map((c) => (
                <LibraryThumb key={c.id} storageKey={c.storageKey} onPick={() => pick(c.id)} />
              ))}
            </div>
          )}
          {photoFrom.isPending && pickedCaptureId != null && (
            <div className="text-[12px] text-muted-foreground mt-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" /> Opening photo…
            </div>
          )}
        </DialogContent>
      </Dialog>
      <CropDialog
        open={open && !!sourcePhotoId}
        title="Choose a photo from the library"
        src={photoUrl.data?.url ?? null}
        loading={photoUrl.isLoading}
        unavailableText="This photo could not be loaded."
        initialBox={DEFAULT_CROP_BOX}
        color="#2d4a22"
        extra={<PhotoSizeSelect value={photoSize} onChange={setPhotoSize} />}
        saveLabel="Use this crop"
        cancelLabel="Back"
        onCancel={reset}
        saving={create.isPending}
        error={create.error?.message ?? null}
        onSave={(box) => sourcePhotoId != null && create.mutate({ itemId, sourcePhotoId, box, photoSize })}
        onClose={closeAll}
      />
    </>
  );
}
