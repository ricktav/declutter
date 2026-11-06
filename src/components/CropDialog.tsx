import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Box } from "@/components/CropBox";
import { Loader2 } from "lucide-react";

import type { CropBox } from "@/lib/cropBox";

/**
 * Full-screen dialog that crops one frame out of a Photo: the image with a
 * draggable/resizable Box, a Cancel/Save row and the save error. It owns the
 * box and puts it back to `initialBox` whenever the dialog opens, the source
 * changes or `initialBox` changes (by value, so an inline literal is fine).
 */
export function CropDialog({
  open,
  title,
  src,
  loading,
  unavailableText,
  initialBox,
  color,
  extra,
  saving,
  error,
  saveLabel,
  cancelLabel = "Cancel",
  onCancel,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  /** The Photo to crop; null (when not loading) shows `unavailableText`. */
  src: string | null;
  loading: boolean;
  unavailableText: string;
  initialBox: CropBox;
  color: string;
  /** Controls between the image and the buttons (e.g. a size picker). */
  extra?: ReactNode;
  saving: boolean;
  error: string | null;
  saveLabel: string;
  /** Label of the left button; defaults to "Cancel". */
  cancelLabel?: string;
  /** Left button action; defaults to `onClose`. The X and Escape always call `onClose`. */
  onCancel?: () => void;
  onSave: (box: CropBox) => void;
  onClose: () => void;
}) {
  const [box, setBox] = useState<CropBox>(initialBox);
  const { xPct, yPct, wPct, hPct } = initialBox;

  useEffect(() => {
    if (open) setBox({ xPct, yPct, wPct, hPct });
  }, [open, src, xPct, yPct, wPct, hPct]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="full">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" /> Loading photo…
          </div>
        ) : !src ? (
          <div className="py-16 text-center text-[13px] text-muted-foreground">{unavailableText}</div>
        ) : (
          <div className="flex flex-col gap-3 items-center">
            <p className="text-[12px] text-muted-foreground -mt-2">Drag to move, drag the corner to resize.</p>
            <div className="relative inline-block select-none max-w-full">
              <img
                src={src}
                alt="source"
                className="block max-h-[calc(100dvh-11rem)] max-w-full w-auto h-auto rounded touch-none"
                draggable={false}
              />
              <Box box={box} color={color} onChange={setBox} />
            </div>
            {extra}
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onCancel ?? onClose} disabled={saving}>
                {cancelLabel}
              </Button>
              <Button size="sm" onClick={() => onSave(box)} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                {saveLabel}
              </Button>
            </div>
            {error && <div className="text-[12px] text-destructive">{error}</div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
