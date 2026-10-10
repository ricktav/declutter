import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { RoomPhotoCard } from "@/components/RoomPhotoCard";
import { RoomPhotoZoom } from "@/components/RoomPhotoZoom";

type PoolCard = {
  key: string;
  storageKey: string;
  captureId: number | null;
  photoId: number | null;
  photoRoomId: number | null;
  onPlan: boolean;
};

/** Source photos for a Place: two-column grid + lightbox with Pin. */
export function RoomPhotoPool({
  roomId,
  title,
  houseId,
}: {
  roomId: number;
  title?: string;
  houseId?: number | null;
}) {
  const captures = trpc.photos.forRoom.useQuery({ roomId }, { enabled: roomId > 0 });
  const roomPhotos = trpc.photos.roomPhotos.useQuery({ roomId }, { enabled: roomId > 0 });
  const [zoom, setZoom] = useState<{ url: string; photoId: number } | null>(null);

  const cards = useMemo<PoolCard[]>(() => {
    const fromCaps: PoolCard[] = (captures.data ?? []).map((p) => ({
      key: `c${p.id}`,
      storageKey: p.storageKey,
      captureId: p.id,
      photoId: p.photoId,
      photoRoomId: p.photoRoomId,
      onPlan: p.camera != null,
    }));
    const seen = new Set(fromCaps.map((c) => c.photoId).filter((id): id is number => id != null));
    const extra: PoolCard[] = (roomPhotos.data ?? [])
      .filter((p) => !p.isCrop && (!p.isCutout || p.camera != null) && !seen.has(p.photoId))
      .map((p) => ({
        key: `p${p.photoId}`,
        storageKey: p.storageKey,
        captureId: null,
        photoId: p.photoId,
        photoRoomId: p.roomId,
        onPlan: p.camera != null && p.roomId === roomId,
      }));
    return [...fromCaps, ...extra];
  }, [captures.data, roomPhotos.data, roomId]);

  const loading = captures.isLoading || roomPhotos.isLoading;

  return (
    <section className="min-w-0 overflow-x-hidden">
      <div className="micro-label text-muted-foreground mb-2">
        Photos
        {cards.length ? ` — ${cards.length}` : ""}
      </div>
      {loading ? (
        <div className="text-[13px] text-muted-foreground">Loading photos…</div>
      ) : !cards.length ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
          No source photos for {title ? <b>{title}</b> : "this room"} yet — the pool fills in as items from this room get detected.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {cards.map((p) => (
            <RoomPhotoCard
              key={p.key}
              storageKey={p.storageKey}
              captureId={p.captureId}
              photoId={p.photoId}
              photoRoomId={p.photoRoomId}
              roomId={roomId}
              houseId={houseId}
              onPlan={p.onPlan}
              onOpen={(url, photoId) => setZoom({ url, photoId })}
            />
          ))}
        </div>
      )}
      {zoom && (
        <RoomPhotoZoom
          url={zoom.url}
          photoId={zoom.photoId}
          title={title}
          onClose={() => setZoom(null)}
        />
      )}
    </section>
  );
}
