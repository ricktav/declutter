import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Camera, ChevronRight, Loader2 } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { PhotoRoomSelect } from "@/components/PhotoRoomSelect";
import { invalidatePhotoPlace } from "@/components/PhotoPlaceDialog";

/**
 * One photo in a room's pool. Pin / Place find-or-create a photo row first
 * when the source is still a capture (same as Annotate). A photo with no
 * Place gets a house-room dropdown.
 */
export function RoomPhotoCard({
  storageKey,
  captureId,
  photoId,
  photoRoomId,
  roomId,
  houseId,
  onPlan,
  onOpen,
}: {
  storageKey: string;
  captureId?: number | null;
  photoId?: number | null;
  photoRoomId?: number | null;
  roomId: number;
  houseId?: number | null;
  onPlan: boolean;
  onOpen: (url: string, photoId: number) => void;
}) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const ensure = trpc.photos.ensureForCapture.useMutation();
  const setRoom = trpc.photos.setRoom.useMutation({
    onSuccess: (res) => {
      invalidatePhotoPlace(utils);
      if (res.roomId != null && res.roomId !== roomId) {
        navigate(`/rooms/${res.roomId}?placePhoto=${res.id}`);
      }
    },
  });
  const [going, setGoing] = useState<"pin" | "place" | "zoom" | null>(null);
  const noRoom = photoRoomId == null;
  const elsewhere = photoRoomId != null && photoRoomId !== roomId;
  const busy = ensure.isPending || setRoom.isPending;
  const placeNeedsRoom = noRoom && photoId != null && captureId == null;

  const assignRoom = (nextRoomId: number) => {
    if (photoId != null) {
      setRoom.mutate({ id: photoId, roomId: nextRoomId });
      return;
    }
    if (captureId == null) return;
    ensure.mutate(
      { captureId, roomId: nextRoomId },
      {
        onSuccess: (res) => {
          invalidatePhotoPlace(utils);
          if (nextRoomId !== roomId) navigate(`/rooms/${nextRoomId}?placePhoto=${res.photoId}`);
        },
      },
    );
  };

  const finish = (to: "pin" | "place" | "zoom", id: number) => {
    if (to === "zoom") onOpen(url.data!.url!, id);
    else if (to === "pin") navigate(`/annotate/${id}`);
    else navigate(`/rooms/${photoRoomId ?? roomId}?placePhoto=${id}`);
  };

  const go = (to: "pin" | "place" | "zoom") => {
    if (to === "zoom" && !url.data?.url) return;
    if (to === "place" && placeNeedsRoom) return;
    if (photoId != null && (to !== "place" || photoRoomId != null)) {
      finish(to, photoId);
      return;
    }
    if (captureId == null) return;
    setGoing(to);
    ensure.mutate(
      { captureId, roomId },
      {
        onSuccess: (res) => {
          invalidatePhotoPlace(utils);
          finish(to, res.photoId);
        },
        onSettled: () => setGoing(null),
      },
    );
  };

  return (
    <div className="relative rounded-lg border border-border bg-white p-2 min-w-0">
      {url.data?.url && (
        <button
          type="button"
          onClick={() => go("zoom")}
          className="absolute top-3 right-3 z-10 h-6 w-6 flex items-center justify-center rounded bg-white/85 text-[13px] leading-none text-muted-foreground hover:text-foreground shadow-sm"
          title="Enlarge"
          aria-label="Enlarge"
        >
          ⤢
        </button>
      )}
      {url.data?.url ? (
        <button type="button" className="block w-full" onClick={() => go("zoom")} title="Open and pin">
          <img src={url.data.url} alt="" className="w-full aspect-video object-cover rounded cursor-zoom-in" />
        </button>
      ) : (
        <div className="w-full aspect-video rounded bg-muted/40" />
      )}
      {onPlan && (
        <span
          className="absolute top-3 left-3 flex items-center gap-1 rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm"
          title="This photo stands on the room's plan as a camera"
        >
          <Camera className="h-3 w-3" /> on the plan
        </span>
      )}
      {noRoom && (
        <div className="mt-1.5">
          <PhotoRoomSelect houseId={houseId} onPick={assignRoom} disabled={busy} />
          {setRoom.isError && <p className="mt-0.5 text-[11px] text-destructive">{setRoom.error.message}</p>}
          {ensure.isError && <p className="mt-0.5 text-[11px] text-destructive">{ensure.error.message}</p>}
        </div>
      )}
      {elsewhere && photoId != null && (
        <Link
          to={`/rooms/${photoRoomId}?placePhoto=${photoId}`}
          className="mt-1.5 block text-[12px] text-primary hover:underline"
        >
          In another room →
        </Link>
      )}
      <button
        type="button"
        onClick={() => go("pin")}
        disabled={busy}
        className="mt-1.5 flex items-center gap-1 text-[12px] text-primary hover:underline disabled:opacity-50"
      >
        {going === "pin" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>
            Pin objects on this photo <ChevronRight className="h-3 w-3" />
          </>
        )}
      </button>
      <button
        type="button"
        onClick={() => go("place")}
        disabled={busy || placeNeedsRoom}
        className="mt-0.5 flex items-center gap-1 text-[12px] text-primary hover:underline disabled:opacity-50"
      >
        {going === "place" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>
            Place on the plan <ChevronRight className="h-3 w-3" />
          </>
        )}
      </button>
    </div>
  );
}
