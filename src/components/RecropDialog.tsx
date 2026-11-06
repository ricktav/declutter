import { trpc } from "@/providers/trpc";
import { CropDialog } from "@/components/CropDialog";
import { invalidatePhotoChange } from "@/hooks/use-photo-from-target";

/** Re-crop a cutout from the original photo it came from. */
export function RecropDialog({
  photoId,
  open,
  onClose,
}: {
  photoId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();

  const source = trpc.photos.sourcePhoto.useQuery(
    { photoId: photoId ?? 0 },
    { enabled: open && photoId != null },
  );
  const available = source.data?.available ? source.data : null;

  const recrop = trpc.photos.recrop.useMutation({
    onSuccess: () => {
      invalidatePhotoChange(utils, { photoId: photoId ?? undefined });
      // ItemDetail reads its attachment list (and thumbnails) through
      // items.get, not photos.listForItem - without this the new
      // storageKey never reaches the page and the old thumbnail lingers
      // (recrop does not return the Thing's id, so every items.get)
      utils.items.get.invalidate();
      onClose();
    },
  });

  return (
    <CropDialog
      open={open}
      title="Re-crop from original photo"
      src={available?.url ?? null}
      loading={source.isLoading}
      unavailableText="This cutout has no linked source photo — it was likely uploaded directly rather than cropped from a snap, so it can't be re-cropped."
      initialBox={available?.cropBox ?? { xPct: 50, yPct: 50, wPct: 30, hPct: 30 }}
      color="#7c3aed"
      saveLabel="Save crop"
      saving={recrop.isPending}
      error={recrop.error?.message ?? null}
      onSave={(box) => photoId != null && recrop.mutate({ photoId, box })}
      onClose={onClose}
    />
  );
}
