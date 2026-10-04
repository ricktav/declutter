// api/lib/placement.ts
// Where a Thing is placed: pinned in photos, on its room's 2D plan (which is
// also its 3D place: both read roomId + pos), and which photos of its room it
// could still be pinned in. items.placement serves the Item view's Placement
// pane; items.placementSummary the badges on many tiles in one call.
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { items, photoPins, photos, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

/** Room photos offered as pin canvases, newest first. */
export const ROOM_PHOTOS_MAX = 30;

export interface Placement {
  itemId: number;
  roomId: number | null;
  roomName: string | null;
  /** the room has scanned walls (a real 3D shell) */
  roomHasGeometry: boolean;
  /** the room has width and depth (the 2D plan, and a box in 3D) */
  roomHasDimensions: boolean;
  /** placed on the plan, and so in 3D: roomId and pos are both set */
  onPlan: boolean;
  /** confirmed pins only */
  pins: Array<{ pinId: number; photoId: number; title: string | null; label: string }>;
  /** photos with this itemId */
  photos: number;
  roomPhotos: Array<{ photoId: number; title: string | null; hasPinForItem: boolean }>;
}

export async function placementFor(db: Db, itemId: number): Promise<Placement> {
  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Thing not found." });
  const room = item.roomId != null ? await db.query.rooms.findFirst({ where: eq(rooms.id, item.roomId) }) : undefined;

  const pins = await db
    .select({ pinId: photoPins.id, photoId: photoPins.photoId, title: photos.title, label: photoPins.label })
    .from(photoPins)
    .innerJoin(photos, eq(photos.id, photoPins.photoId))
    .where(and(eq(photoPins.itemId, itemId), eq(photoPins.status, "confirmed")))
    .orderBy(desc(photoPins.createdAt), desc(photoPins.id));
  const [{ n: photoCount }] = await db.select({ n: count() }).from(photos).where(eq(photos.itemId, itemId));

  return {
    itemId: item.id,
    roomId: item.roomId ?? null,
    roomName: room?.name ?? null,
    roomHasGeometry: room?.walls != null,
    roomHasDimensions: room?.widthM != null && room?.depthM != null,
    onPlan: item.roomId != null && item.pos != null,
    pins,
    photos: Number(photoCount),
    roomPhotos: room ? await roomPhotosFor(db, room.id, item.id, new Set(pins.map((p) => p.photoId))) : [],
  };
}

/** The photos of a room a Thing could be pinned in: the room's item-less
 * photos, plus what photos.forRoom selects for the room's other active
 * Things (their photos cut from a capture) and the location photos of those
 * captures (the full images that cutouts were cropped from). */
async function roomPhotosFor(db: Db, roomId: number, itemId: number, pinnedPhotoIds: Set<number>): Promise<Placement["roomPhotos"]> {
  const others = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.status, "active"), eq(items.roomId, roomId), ne(items.id, itemId)));
  const otherIds = others.map((o) => o.id);
  const cutouts = otherIds.length
    ? await db
        .select({ id: photos.id, title: photos.title, createdAt: photos.createdAt, sourceCaptureId: photos.sourceCaptureId })
        .from(photos)
        .where(and(inArray(photos.itemId, otherIds), isNotNull(photos.sourceCaptureId)))
    : [];
  const captureIds = [...new Set(cutouts.map((c) => c.sourceCaptureId).filter((x): x is number => x != null))];
  const itemless = await db
    .select({ id: photos.id, title: photos.title, createdAt: photos.createdAt })
    .from(photos)
    .where(
      and(
        isNull(photos.itemId),
        captureIds.length ? or(eq(photos.roomId, roomId), inArray(photos.sourceCaptureId, captureIds)) : eq(photos.roomId, roomId),
      ),
    );
  const byId = new Map<number, { id: number; title: string | null; createdAt: Date }>();
  for (const p of [...itemless, ...cutouts]) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()]
    .sort((a, b) => +b.createdAt - +a.createdAt || b.id - a.id)
    .slice(0, ROOM_PHOTOS_MAX)
    .map((p) => ({ photoId: p.id, title: p.title, hasPinForItem: pinnedPhotoIds.has(p.id) }));
}

/** Badges for many Things in two queries: confirmed pins per item, and each
 * item's roomId/pos. One row per distinct requested id, in request order; an
 * unknown id reads as not pinned and not on the plan. */
export async function placementSummaryFor(
  db: Db,
  itemIds: number[],
): Promise<Array<{ itemId: number; pinCount: number; onPlan: boolean }>> {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return [];
  const pinRows = await db
    .select({ itemId: photoPins.itemId, n: count() })
    .from(photoPins)
    .where(and(inArray(photoPins.itemId, ids), eq(photoPins.status, "confirmed")))
    .groupBy(photoPins.itemId);
  const itemRows = await db.select({ id: items.id, roomId: items.roomId, pos: items.pos }).from(items).where(inArray(items.id, ids));
  const pinsBy = new Map(pinRows.map((r) => [r.itemId, Number(r.n)]));
  const itemBy = new Map(itemRows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const it = itemBy.get(id);
    return { itemId: id, pinCount: pinsBy.get(id) ?? 0, onPlan: it != null && it.roomId != null && it.pos != null };
  });
}
