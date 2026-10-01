import { useEffect, useState } from "react";
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

/** Re-crop a cutout from the original photo it came from. */
export function RecropDialog({
  attachmentId,
  open,
  onClose,
}: {
  attachmentId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [box, setBox] = useState<CropBox>({ xPct: 50, yPct: 50, wPct: 30, hPct: 30 });

  const source = trpc.attachments.sourcePhoto.useQuery(
    { attachmentId: attachmentId ?? 0 },
    { enabled: open && attachmentId != null },
  );

  useEffect(() => {
    if (source.data?.available && source.data.cropBox) setBox(source.data.cropBox);
  }, [source.data]);

  const recrop = trpc.attachments.recrop.useMutation({
    onSuccess: () => {
      utils.attachments.listForItem.invalidate();
      utils.attachments.urlForAttachment.invalidate();
      // ItemDetail reads its attachment list (and thumbnails) through
      // items.get, not attachments.listForItem - without this the new
      // storageKey never reaches the page and the old thumbnail lingers
      utils.items.get.invalidate();
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-screen h-[100dvh] max-w-none sm:max-w-none rounded-none p-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Re-crop from original photo</DialogTitle>
        </DialogHeader>

        {source.isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> Loading original photo…
          </div>
        ) : !source.data?.available ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground">
            This cutout has no linked source photo — it was likely uploaded directly rather than cropped from a capture, so it can't be re-cropped.
          </div>
        ) : (
          <div className="flex flex-col gap-3 items-center">
            <div className="relative select-none mx-auto max-w-full">
              <img
                src={source.data.url ?? ""}
                alt="original"
                className="max-h-[calc(100dvh-11rem)] w-auto rounded touch-none"
                draggable={false}
              />
              <Box box={box} color="#7c3aed" onChange={setBox} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={recrop.isPending}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => attachmentId != null && recrop.mutate({ attachmentId, box })}
                disabled={recrop.isPending}
              >
                {recrop.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                Save crop
              </Button>
            </div>
            {recrop.isError && (
              <div className="text-[12px] text-destructive">{recrop.error.message}</div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
