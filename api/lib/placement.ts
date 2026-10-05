// api/lib/placement.ts
// Where a Thing is placed: pinned in photos, on its room's 2D plan (which is
// also its 3D place: both read roomId + pos), and which photos of its room it
// could still be pinned in. items.placement serves the Item view's Placement
// pane; items.placementSummary the badges on many tiles in one call.
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { items, photoPins, photos, rooms, type PhotoCamera } from "@db/schema";
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
  /** the room has a 2D plan to place on: width and depth both above zero */
  roomHasPlan: boolean;
  /** the Thing this one sits inside (items.parentId); it is placed with its host */
  parentId: number | null;
  parentName: string | null;
  /** placed on the plan, and so in 3D: roomId and pos are both set */
  onPlan: boolean;
  /** confirmed pins only; roomId, isCutout and isCrop are the pin's photo's (a camera stands only on an uncropped photo with a room) */
  pins: Array<{
    pinId: number;
    photoId: number;
    title: string | null;
    label: string;
    camera: PhotoCamera | null;
    roomId: number | null;
    isCutout: boolean;
    /** the photo is a crop (cropBox set); a crop never gets a camera */
    isCrop: boolean;
  }>;
  /** photos with this itemId */
  photos: number;
  /** non-cutouts first, then newest first, max ROOM_PHOTOS_MAX */
  roomPhotos: Array<RoomPhoto & { hasPinForItem: boolean }>;
}

export async function placementFor(db: Db, itemId: number): Promise<Placement> {
  const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Thing not found." });
  const room = item.roomId != null ? await db.query.rooms.findFirst({ where: eq(rooms.id, item.roomId) }) : undefined;

  const pinRows = await db
    .select({
      pinId: photoPins.id,
      photoId: photoPins.photoId,
      title: photos.title,
      label: photoPins.label,
      camera: photos.camera,
      roomId: photos.roomId,
      cropBox: photos.cropBox,
    })
    .from(photoPins)
    .innerJoin(photos, eq(photos.id, photoPins.photoId))
    .where(and(eq(photoPins.itemId, itemId), eq(photoPins.status, "confirmed")))
    .orderBy(desc(photoPins.createdAt), desc(photoPins.id));
  const pins = pinRows.map(({ cropBox, ...pin }) => ({
    ...pin,
    camera: pin.camera ?? null,
    roomId: pin.roomId ?? null,
    isCutout: cropBox != null,
    isCrop: cropBox != null,
  }));
  const pinnedIds = new Set(pins.map((p) => p.photoId));
  const [{ n: photoCount }] = await db.select({ n: count() }).from(photos).where(eq(photos.itemId, itemId));
  const parent = item.parentId != null ? await db.query.items.findFirst({ where: eq(items.id, item.parentId) }) : undefined;

  return {
    itemId: item.id,
    roomId: item.roomId ?? null,
    roomName: room?.name ?? null,
    roomHasGeometry: room?.walls != null,
    roomHasDimensions: room?.widthM != null && room?.depthM != null,
    roomHasPlan: (room?.widthM ?? 0) > 0 && (room?.depthM ?? 0) > 0,
    parentId: item.parentId ?? null,
    parentName: parent?.name ?? null,
    onPlan: item.roomId != null && item.pos != null,
    pins,
    photos: Number(photoCount),
    roomPhotos: room
      ? (await roomPhotosFor(db, room.id, { forItemId: item.id })).map((p) => ({ ...p, hasPinForItem: pinnedIds.has(p.photoId) }))
      : [],
  };
}

/** One photo of a room: a pin canvas for the Placement pane, a camera
 * marker candidate for the plan. */
export interface RoomPhoto {
  photoId: number;
  title: string | null;
  storageKey: string;
  itemId: number | null;
  itemName: string | null;
  /** the photo's own room (photos.roomId): a capture's location photo or a
   * cutout can belong to another room, or none; a camera only stands in this
   * room's frame */
  roomId: number | null;
  /** a crop, or another Thing's own photo: a poor pin canvas */
  isCutout: boolean;
  /** a crop (cropBox set): never a camera. A Thing's own uncropped photo is
   * a cutout but can stand on the plan, so markers test this, not isCutout. */
  isCrop: boolean;
  camera: PhotoCamera | null;
  /** confirmed pins on the photo */
  pinCount: number;
}

/** The photos of a room: the room's item-less photos, plus what
 * photos.forRoom selects for the room's active Things (their photos cut from
 * a capture) and the location photos of those captures (the full images
 * that cutouts were cropped from), each with its camera. With forItemId, that Thing's own photos
 * are left out (the photos it could still be pinned in). A cutout is a poor
 * pin canvas and not a viewpoint, so full images rank first, then newest
 * first; the limit applies after that ordering. With withCameras, the
 * room's uncropped Thing-owned photos that stand in it (camera set) are added
 * too, ranked with the full images, so the plan draws every camera in the
 * room. Shared by items.placement and photos.roomPhotos. */
export async function roomPhotosFor(
  db: Db,
  roomId: number,
  opts: { forItemId?: number; limit?: number; withCameras?: boolean } = {},
): Promise<RoomPhoto[]> {
  const others = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(eq(items.status, "active"), eq(items.roomId, roomId), opts.forItemId != null ? ne(items.id, opts.forItemId) : undefined),
    );
  const otherIds = others.map((o) => o.id);
  const cols = {
    id: photos.id,
    title: photos.title,
    storageKey: photos.storageKey,
    createdAt: photos.createdAt,
    sourceCaptureId: photos.sourceCaptureId,
    itemId: photos.itemId,
    cropBox: photos.cropBox,
    camera: photos.camera,
    roomId: photos.roomId,
  };
  const cutouts = otherIds.length
    ? await db
        .select(cols)
        .from(photos)
        .where(and(inArray(photos.itemId, otherIds), isNotNull(photos.sourceCaptureId)))
    : [];
  const captureIds = [...new Set(cutouts.map((c) => c.sourceCaptureId).filter((x): x is number => x != null))];
  const itemless = await db
    .select(cols)
    .from(photos)
    .where(
      and(
        isNull(photos.itemId),
        captureIds.length ? or(eq(photos.roomId, roomId), inArray(photos.sourceCaptureId, captureIds)) : eq(photos.roomId, roomId),
      ),
    );
  const standing = opts.withCameras
    ? await db
        .select(cols)
        .from(photos)
        .where(and(eq(photos.roomId, roomId), isNotNull(photos.itemId), isNull(photos.cropBox), isNotNull(photos.camera)))
    : [];
  const byId = new Map<number, (typeof itemless)[number] & { isCutout: boolean; isCrop: boolean }>();
  for (const p of [...itemless, ...cutouts, ...standing]) {
    if (!byId.has(p.id)) byId.set(p.id, { ...p, isCutout: p.cropBox != null || p.itemId != null, isCrop: p.cropBox != null });
  }
  // a viewpoint (a full image, or a Thing's uncropped photo with a camera) ranks first
  const rank = (p: { isCutout: boolean; isCrop: boolean; camera: unknown }) => Number(p.isCutout && !(p.camera != null && !p.isCrop));
  const picked = [...byId.values()]
    .sort((a, b) => rank(a) - rank(b) || +b.createdAt - +a.createdAt || b.id - a.id)
    .slice(0, opts.limit ?? ROOM_PHOTOS_MAX);
  if (!picked.length) return [];

  const ids = picked.map((p) => p.id);
  const pinRows = await db
    .select({ photoId: photoPins.photoId, n: count() })
    .from(photoPins)
    .where(and(inArray(photoPins.photoId, ids), eq(photoPins.status, "confirmed")))
    .groupBy(photoPins.photoId);
  const pinsBy = new Map(pinRows.map((r) => [r.photoId, Number(r.n)]));
  const ownerIds = [...new Set(picked.map((p) => p.itemId).filter((x): x is number => x != null))];
  const owners = ownerIds.length ? await db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, ownerIds)) : [];
  const nameBy = new Map(owners.map((o) => [o.id, o.name]));
  return picked.map((p) => ({
    photoId: p.id,
    title: p.title,
    storageKey: p.storageKey,
    itemId: p.itemId ?? null,
    itemName: p.itemId != null ? (nameBy.get(p.itemId) ?? null) : null,
    roomId: p.roomId ?? null,
    isCutout: p.isCutout,
    isCrop: p.isCrop,
    camera: p.camera ?? null,
    pinCount: pinsBy.get(p.id) ?? 0,
  }));
}

/** Badges for many Things in two or three queries: confirmed pins per item,
 * each item's roomId/pos, and the hosts of Things that sit inside another (a
 * hosted Thing is on the plan when its host is). One row per distinct
 * requested id, in request order; an unknown id reads as not pinned and not
 * on the plan. */
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
  const itemRows = await db
    .select({ id: items.id, roomId: items.roomId, pos: items.pos, parentId: items.parentId })
    .from(items)
    .where(inArray(items.id, ids));
  const hostIds = [...new Set(itemRows.map((r) => r.parentId).filter((x): x is number => x != null))];
  const hostRows = hostIds.length
    ? await db.select({ id: items.id, roomId: items.roomId, pos: items.pos }).from(items).where(inArray(items.id, hostIds))
    : [];
  const pinsBy = new Map(pinRows.map((r) => [r.itemId, Number(r.n)]));
  const itemBy = new Map(itemRows.map((r) => [r.id, r]));
  const hostBy = new Map(hostRows.map((r) => [r.id, r]));
  const placed = (r: { roomId: number | null; pos: unknown } | undefined) => r != null && r.roomId != null && r.pos != null;
  return ids.map((id) => {
    const it = itemBy.get(id);
    const onPlan = placed(it) || (it?.parentId != null && placed(hostBy.get(it.parentId)));
    return { itemId: id, pinCount: pinsBy.get(id) ?? 0, onPlan };
  });
}
