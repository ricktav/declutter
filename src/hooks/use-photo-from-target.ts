import { useCallback } from "react";
import { trpc } from "@/providers/trpc";

/** A photo to act on: a real photo, or an inbox capture that first has to
 * become a photo (photos.ensureForCapture) before it can be pinned, placed
 * or attached. */
export type PhotoTarget = { source: "photo"; photoId: number } | { source: "capture"; captureId: number };

/** A stable React `key` for a target: `p<id>` for a photo, `c<id>` for a capture. */
export function photoTargetKey(t: PhotoTarget): string {
  return t.source === "photo" ? `p${t.photoId}` : `c${t.captureId}`;
}

/** The one capture→Photo promotion. `resolve` returns the photo id: a photo's
 * own, or the server's find-or-create photo for a capture (with `roomId` as
 * its Place when it has none yet). It always asks the server for a capture;
 * no id is cached here. The server reuses only a bare Photo (no Thing yet), so
 * two dialogs on the same capture share one Photo only until it is attached to
 * a Thing: after that a capture target would get a second Photo. */
export function usePhotoFromTarget() {
  const ensure = trpc.photos.ensureForCapture.useMutation();
  const { mutateAsync } = ensure;
  const resolve = useCallback(
    async (t: PhotoTarget, roomId?: number | null): Promise<number> => {
      if (t.source === "photo") return t.photoId;
      const res = await mutateAsync({ captureId: t.captureId, ...(roomId !== undefined ? { roomId } : {}) });
      return res.photoId;
    },
    [mutateAsync],
  );
  return { resolve, isPending: ensure.isPending, error: ensure.error };
}

/** The queries that show a photo, its Place, its pins or its Thing's photos.
 * `itemIds` also refreshes those Things' detail; `photoId` a cutout's source view.
 * The returned promise settles once every refetch is done; callers that only
 * need the refresh to start can ignore it. */
export function invalidatePhotoChange(
  utils: ReturnType<typeof trpc.useUtils>,
  opts?: { itemIds?: number[]; photoId?: number },
): Promise<void> {
  const all: Promise<void>[] = [
    utils.photos.get.invalidate(),
    utils.photos.listAll.invalidate(),
    utils.photos.forRoom.invalidate(),
    utils.photos.roomPhotos.invalidate(),
    utils.photos.listForItem.invalidate(),
    utils.rooms.get.invalidate(),
    utils.inbox.list.invalidate(),
    utils.items.listAll.invalidate(),
    utils.items.placement.invalidate(),
    utils.items.placementSummary.invalidate(),
    ...(opts?.itemIds ?? []).map((id) => utils.items.get.invalidate({ id })),
  ];
  if (opts?.photoId != null) all.push(utils.photos.sourcePhoto.invalidate({ photoId: opts.photoId }));
  return Promise.all(all).then(() => undefined);
}
