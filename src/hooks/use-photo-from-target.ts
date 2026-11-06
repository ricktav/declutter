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
 * its Place when it has none yet). It always asks the server for a capture,
 * so two dialogs on the same capture share one Photo; no id is cached here. */
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
 * `itemIds` also refreshes those Things' detail; `photoId` a cutout's source view. */
export function invalidatePhotoChange(
  utils: ReturnType<typeof trpc.useUtils>,
  opts?: { itemIds?: number[]; photoId?: number },
): void {
  void utils.photos.get.invalidate();
  void utils.photos.listAll.invalidate();
  void utils.photos.forRoom.invalidate();
  void utils.photos.roomPhotos.invalidate();
  void utils.photos.listForItem.invalidate();
  void utils.rooms.get.invalidate();
  void utils.inbox.list.invalidate();
  void utils.items.listAll.invalidate();
  void utils.items.placement.invalidate();
  void utils.items.placementSummary.invalidate();
  for (const id of opts?.itemIds ?? []) void utils.items.get.invalidate({ id });
  if (opts?.photoId != null) void utils.photos.sourcePhoto.invalidate({ photoId: opts.photoId });
}
