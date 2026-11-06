import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HouseRoomFields } from "@/components/HouseRoomFields";

/**
 * One dialog to pick a Place: house (when the header shows all houses) and
 * room, then an explicit confirm. The caller owns the mutation and closes
 * the dialog on success; this only reports the selection.
 */
export function PlacePickerDialog({
  open,
  title,
  description,
  houseId,
  roomId,
  allowNone,
  confirmLabel,
  busy,
  error,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  houseId: number | null;
  roomId: number | null;
  allowNone?: boolean;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onPick: (sel: { houseId: number | null; roomId: number | null }) => void;
  onClose: () => void;
}) {
  const [house, setHouse] = useState<number | null>(houseId);
  const [room, setRoom] = useState<number | null>(roomId);

  // start from the caller's values each time the dialog opens
  useEffect(() => {
    if (open) {
      setHouse(houseId);
      setRoom(roomId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md overflow-visible">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <HouseRoomFields
          houseId={house}
          roomId={room}
          onHouse={setHouse}
          onRoom={setRoom}
          allowNone={allowNone}
          lockToSession
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || (!allowNone && room == null)}
            onClick={() => onPick({ houseId: house, roomId: room })}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
