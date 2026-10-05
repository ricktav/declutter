import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { RoomPicker } from "@/components/RoomPicker";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** The photo whose Place changes: a real photo (photos.setRoom), or an inbox
 * capture that becomes a photo in the chosen room (photos.ensureForCapture). */
export type PlaceTarget =
  | { source: "photo"; photoId: number; roomId: number | null; houseId: number | null; ofThing: boolean; hasCamera: boolean }
  | { source: "capture"; captureId: number };

/** What changed, for the caller's confirmation line. */
export type PlaceResult = { roomName: string | null; cameraCleared: boolean; ofThing: boolean };

/** The queries that show a photo's room. */
// eslint-disable-next-line react-refresh/only-export-components
export function invalidatePhotoPlace(utils: ReturnType<typeof trpc.useUtils>) {
  utils.photos.get.invalidate();
  utils.photos.listAll.invalidate();
  utils.photos.forRoom.invalidate();
  utils.photos.roomPhotos.invalidate();
  utils.rooms.get.invalidate();
}

/** Change a Photo's Place from the Photos page. */
export function PhotoPlaceDialog({
  target,
  onClose,
  onMoved,
}: {
  target: PlaceTarget | null;
  onClose: () => void;
  onMoved: (res: PlaceResult) => void;
}) {
  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        {target && (
          <PlaceBody
            key={target.source === "photo" ? `p${target.photoId}` : `c${target.captureId}`}
            target={target}
            onClose={onClose}
            onMoved={onMoved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlaceBody({
  target,
  onClose,
  onMoved,
}: {
  target: PlaceTarget;
  onClose: () => void;
  onMoved: (res: PlaceResult) => void;
}) {
  const utils = trpc.useUtils();
  const { houseId: sessionHouseId } = useHouse();
  const houseId = (target.source === "photo" ? target.houseId : null) ?? sessionHouseId ?? undefined;
  const allRooms = trpc.rooms.list.useQuery({ houseId: null });
  const storedRoomId = target.source === "photo" ? target.roomId : null;
  const [value, setValue] = useState<number | null>(storedRoomId);
  // remounts the picker so its text snaps back to the stored room after a failed save
  const [pickerKey, setPickerKey] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const resetPicker = () => {
    setValue(storedRoomId);
    setPickerKey((k) => k + 1);
  };
  // read after rooms.list is refetched: the picker may have just made the room
  const nameOf = (id: number | null) => {
    if (id == null) return null;
    const list = utils.rooms.list.getData({ houseId: null }) ?? allRooms.data;
    return list?.find((r) => r.id === id)?.name ?? `#${id}`;
  };

  const setRoom = trpc.photos.setRoom.useMutation({
    onSuccess: async (res) => {
      // a room just made by the picker is not in the list yet
      await utils.rooms.list.invalidate();
      invalidatePhotoPlace(utils);
      onMoved({ roomName: nameOf(res.roomId), cameraCleared: res.cameraCleared, ofThing: target.source === "photo" && target.ofThing });
      onClose();
    },
    onError: resetPicker,
  });
  const ensure = trpc.photos.ensureForCapture.useMutation({
    onSuccess: async (_res, vars) => {
      await utils.rooms.list.invalidate();
      invalidatePhotoPlace(utils);
      onMoved({ roomName: nameOf(vars.roomId ?? null), cameraCleared: false, ofThing: false });
      onClose();
    },
    onError: resetPicker,
  });
  const pending = setRoom.isPending || ensure.isPending;
  const error = setRoom.error ?? ensure.error;

  // only a picked room (or the confirmed "Clear Place") saves; the picker
  // never clears the Place by itself
  const pick = (roomId: number | null) => {
    if (roomId == null) return;
    setValue(roomId);
    setConfirmClear(false);
    if (target.source === "photo") {
      if (roomId !== target.roomId) setRoom.mutate({ id: target.photoId, roomId });
    } else {
      ensure.mutate({ captureId: target.captureId, roomId });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Change Place</DialogTitle>
        <DialogDescription>
          Where this Photo was taken.
          {target.source === "photo" && target.ofThing && " The Thing itself stays where it is."}
        </DialogDescription>
      </DialogHeader>
      {houseId == null ? (
        <p className="text-[12px] text-muted-foreground">Choose a house first (top bar).</p>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <RoomPicker key={pickerKey} value={value} onChange={pick} houseId={houseId} autoFocus />
          </div>
          {pending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      )}
      {target.source === "photo" && target.roomId != null && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {confirmClear ? (
            <>
              <span>Clear the Place?{target.hasCamera ? " Its camera marker is lost too." : ""}</span>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-[12px]"
                disabled={pending}
                onClick={() => setRoom.mutate({ id: target.photoId, roomId: null })}
              >
                Clear Place
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={pending} onClick={() => setConfirmClear(true)}>
              Clear Place…
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-[12px] text-destructive">Not saved: {error.message}</p>}
    </>
  );
}
