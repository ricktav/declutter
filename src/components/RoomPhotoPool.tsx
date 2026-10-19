import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { RoomSchema } from "@/components/RoomSchema";
import { withoutSchema } from "@/lib/schemaFilter";
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

/** Source photos for a Place: two-column grid + lightbox with Pin, or
 * (`?schema=1`) the Schema view of the Things pinned in them. */
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
  const [params, setParams] = useSearchParams();
  const schema = params.get("schema") === "1";
  const setSchema = (on: boolean) =>
    setParams(
      (prev) => {
        if (!on) return withoutSchema(prev);
        const next = new URLSearchParams(prev);
        next.set("schema", "1");
        return next;
      },
      { replace: true },
    );

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

  const switcher = (
    <div className="flex items-center gap-1 mb-2 rounded-md bg-muted/50 p-0.5 w-fit" role="tablist">
      {([
        [false, `Photos${cards.length ? ` — ${cards.length}` : ""}`],
        [true, "Schema"],
      ] as const).map(([on, label]) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={schema === on}
          data-testid={on ? "view-schema" : "view-photos"}
          onClick={() => setSchema(on)}
          className={
            "px-3 py-1 rounded text-[12px] font-medium " +
            (schema === on ? "bg-white shadow-sm" : "text-muted-foreground hover:text-foreground")
          }
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (schema) {
    return (
      <section className="min-w-0 overflow-x-hidden">
        {switcher}
        <RoomSchema roomId={roomId} />
      </section>
    );
  }

  return (
    <section className="min-w-0 overflow-x-hidden">
      {switcher}
      {loading ? (
        <div className="text-[13px] text-muted-foreground">Loading photos…</div>
      ) : !cards.length ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
          No source photos for {title ? <b>{title}</b> : "this Place"} yet — the pool fills in as Things from this Place get detected.
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
