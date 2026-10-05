// api/lib/photos.ts
// Shared reads and writes for photos (images) and item_links (link, note,
// file). The photos/pins/itemLinks routers and the deprecated attachments.*
// aliases all go through these, so each table is written one way.
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { areas, captures, itemLinks, items, photoPins, photos, rooms, type CropBox, type ItemLink, type ItemPos, type Photo, type PhotoCamera } from "@db/schema";
import type { getDb } from "../queries/connection";
import { deleteStoredFile, putFile, readFileBytes } from "./filestore";
import { sniffMime } from "./sniff";
import { logEvent } from "./events";
import { releaseStoredFiles } from "./entities";
import { roomSummary } from "./location";

type Db = ReturnType<typeof getDb>;
type Tx = Pick<Db, "select" | "insert" | "update" | "query">;

/** The box a cutout was cropped with, in percent of the source photo (center + size). */
export interface PinBox {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

/** A cutout means its item is in the source photo: make sure that photo
 * carries a confirmed pin for the item, so the item's "Seen in photos"
 * (pins.listForItem) shows it. One pin per (photo, item): an existing one
 * (an AI suggestion, a pin drawn first) is confirmed and keeps its box. */
export async function ensurePinForCutout(
  tx: Tx,
  input: { sourcePhotoId: number; itemId: number; box: PinBox; label: string; summary?: string },
): Promise<{ id: number; created: boolean }> {
  const existing = await tx.query.photoPins.findFirst({
    where: and(eq(photoPins.photoId, input.sourcePhotoId), eq(photoPins.itemId, input.itemId)),
  });
  if (existing) {
    if (existing.status !== "confirmed") {
      await tx.update(photoPins).set({ status: "confirmed" }).where(eq(photoPins.id, existing.id));
    }
    return { id: existing.id, created: false };
  }
  const [{ id }] = await tx
    .insert(photoPins)
    .values({
      photoId: input.sourcePhotoId,
      itemId: input.itemId,
      xPct: input.box.xPct,
      yPct: input.box.yPct,
      wPct: input.box.wPct,
      hPct: input.box.hPct,
      label: input.label.slice(0, 255),
      origin: "user",
      status: "confirmed",
    })
    .$returningId();
  await logEvent(
    {
      entityType: "pin",
      entityId: id,
      action: "pin-added",
      summary: input.summary ?? `Pin "${input.label || "untitled"}" added to photo #${input.sourcePhotoId} for the cutout of item #${input.itemId}`,
    },
    tx,
  );
  return { id, created: true };
}

/** Find-or-create the bare, item-less "location photo" of a capture: the
 * full image a pin canvas works on (cutouts carry the same sourceCaptureId
 * but have an itemId). The capture row is locked first, so two calls at once
 * (a double tap, two tabs) make one photo. A room given later is kept when
 * the photo had none. */
export async function ensureLocationPhotoForCapture(
  db: Db,
  captureId: number,
  roomId?: number | null,
): Promise<{ photoId: number; created: boolean }> {
  const written: string[] = [];
  try {
    return await db.transaction((tx) => ensureLocationPhotoInTx(tx, captureId, roomId, written));
  } catch (err) {
    for (const k of written) await deleteStoredFile(k).catch(() => {});
    throw err;
  }
}

/** ensureLocationPhotoForCapture inside a caller's transaction (inbox.acceptMany
 * pins several Things on one photo in one go). The key of a file it writes is
 * pushed to `written`: the caller deletes it when its transaction rolls back. */
export async function ensureLocationPhotoInTx(
  tx: Tx,
  captureId: number,
  roomId: number | null | undefined,
  written: string[],
): Promise<{ photoId: number; created: boolean }> {
  // Lock the capture row first: a second call for the same capture waits
  // here until the first call committed. The photo lookup is a locking read
  // too: it reads the latest committed rows, not the snapshot of a caller's
  // transaction that began before the wait (inbox.acceptMany reads first),
  // so it finds the photo made meanwhile instead of making another one.
  const [cap] = await tx.select().from(captures).where(eq(captures.id, captureId)).for("update");
  const [existing] = await tx
    .select()
    .from(photos)
    .where(and(eq(photos.sourceCaptureId, captureId), isNull(photos.itemId)))
    .orderBy(asc(photos.id))
    .limit(1)
    .for("update");
  if (existing) {
    // a room confirmed just now (Inbox's pending-item "Pin" flow) is worth keeping
    if (roomId != null && existing.roomId == null) {
      // a camera lives in its room's frame: a new room drops it
      await tx.update(photos).set({ roomId, camera: null }).where(eq(photos.id, existing.id));
    }
    return { photoId: existing.id, created: false };
  }
  if (!cap?.storageKey) throw new TRPCError({ code: "NOT_FOUND", message: "Capture has no stored photo." });
  let bytes: Uint8Array;
  try {
    bytes = await readFileBytes(cap.storageKey);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
  }
  const mimeType = await sniffMime(bytes, cap.storageKey);
  // own copy of the bytes: a capture and a photo never share a key
  const copy = await putFile({ bytes, fileName: `locations/${cap.storageKey.split("/").pop() ?? "photo"}`, contentType: mimeType });
  written.push(copy.key);
  const [{ id }] = await tx
    .insert(photos)
    .values({
      storageKey: copy.key,
      size: copy.size,
      mimeType,
      sourceCaptureId: cap.id,
      roomId: roomId ?? null,
      title: "Location photo",
    })
    .$returningId();
  await logEvent({ entityType: "photo", entityId: id, action: "created", summary: `Location photo created from capture #${cap.id}` }, tx);
  return { photoId: id, created: true };
}

export type ItemLinkKind = "link" | "note" | "file";

/** First photo (lowest id) of each item: its cover thumbnail and its AI
 * reference photo. Every item with a photo when itemIds is omitted. */
export async function coverPhotos(db: Db, itemIds?: number[]): Promise<Map<number, { id: number; storageKey: string }>> {
  const out = new Map<number, { id: number; storageKey: string }>();
  if (itemIds && itemIds.length === 0) return out;
  const rows = await db
    .select({ id: photos.id, itemId: photos.itemId, storageKey: photos.storageKey })
    .from(photos)
    .where(itemIds ? inArray(photos.itemId, itemIds) : isNotNull(photos.itemId))
    .orderBy(asc(photos.id));
  for (const r of rows) if (r.itemId != null && !out.has(r.itemId)) out.set(r.itemId, { id: r.id, storageKey: r.storageKey });
  return out;
}

export async function addPhoto(
  db: Db,
  input: { itemId?: number | null; areaId?: number | null; title?: string | null; storageKey: string; fileName?: string },
): Promise<{ id: number; storageKey: string }> {
  const bytes = await readFileBytes(input.storageKey);
  const mimeType = await sniffMime(bytes, input.fileName);
  const [{ id }] = await db
    .insert(photos)
    .values({
      itemId: input.itemId ?? null,
      areaId: input.areaId ?? null,
      title: input.title ?? null,
      storageKey: input.storageKey,
      mimeType,
      size: bytes.byteLength,
    })
    .$returningId();
  await logEvent({
    entityType: "photo",
    entityId: id,
    action: "created",
    summary: `Photo "${input.title ?? input.fileName ?? id}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
    payload: { itemId: input.itemId ?? null, areaId: input.areaId ?? null },
  });
  return { id, storageKey: input.storageKey };
}

/** Delete a photo and the pins drawn on it; the file goes only if nothing else uses it. */
export async function removePhoto(db: Db, id: number): Promise<{ ok: true }> {
  const row = await db.query.photos.findFirst({ where: eq(photos.id, id) });
  await db.transaction(async (tx) => {
    await tx.delete(photoPins).where(eq(photoPins.photoId, id));
    await tx.delete(photos).where(eq(photos.id, id));
    await logEvent({ entityType: "photo", entityId: id, action: "deleted", summary: `Photo "${row?.title ?? id}" removed` }, tx);
  });
  if (row) await releaseStoredFiles(db, [row.storageKey]);
  return { ok: true as const };
}

/** Un-pin a photo from its item without deleting it: it goes back to the
 * Photos pool, keeping the item's room so it does not lose its place. Used by
 * photos.unlink and the deprecated attachments.unlink alias. */
export async function unlinkPhoto(db: Db, id: number): Promise<{ ok: true }> {
  const photo = await db.query.photos.findFirst({ where: eq(photos.id, id) });
  if (!photo) throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found." });
  const item = photo.itemId ? await db.query.items.findFirst({ where: eq(items.id, photo.itemId) }) : null;
  const roomId = photo.roomId ?? item?.roomId ?? null;
  await db
    .update(photos)
    // a camera lives in its room's frame: a new room drops it
    .set({ itemId: null, roomId, ...(roomId !== photo.roomId ? { camera: null } : {}) })
    .where(eq(photos.id, id));
  await logEvent({
    entityType: "photo",
    entityId: id,
    action: "unlinked",
    summary: `Photo "${photo.title ?? id}" unlinked from item #${photo.itemId} - back in the photo pool`,
  });
  return { ok: true as const };
}

export async function addItemLink(
  db: Db,
  input: {
    itemId?: number | null;
    areaId?: number | null;
    kind: ItemLinkKind;
    title?: string | null;
    content?: string | null;
    url?: string | null;
    storageKey?: string | null;
    fileName?: string;
    mimeType?: string | null;
    sourceCaptureId?: number | null;
  },
): Promise<{ id: number; storageKey: string | null }> {
  let storageKey: string | null = null;
  let size: number | null = null;
  let mimeType = input.mimeType ?? null;
  if (input.kind === "file" && input.storageKey) {
    const bytes = await readFileBytes(input.storageKey);
    mimeType = await sniffMime(bytes, input.fileName);
    storageKey = input.storageKey;
    size = bytes.byteLength;
  }
  const [{ id }] = await db
    .insert(itemLinks)
    .values({
      itemId: input.itemId ?? null,
      areaId: input.areaId ?? null,
      kind: input.kind,
      title: input.title ?? null,
      content: input.content ?? null,
      url: input.url ?? null,
      storageKey,
      mimeType,
      size,
      sourceCaptureId: input.sourceCaptureId ?? null,
    })
    .$returningId();
  await logEvent({
    entityType: "item_link",
    entityId: id,
    action: "created",
    summary: `${input.kind} "${input.title ?? input.fileName ?? input.url ?? "note"}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
    payload: { itemId: input.itemId ?? null, areaId: input.areaId ?? null, kind: input.kind },
  });
  return { id, storageKey };
}

export async function removeItemLink(db: Db, id: number): Promise<{ ok: true }> {
  const row = await db.query.itemLinks.findFirst({ where: eq(itemLinks.id, id) });
  await db.transaction(async (tx) => {
    await tx.delete(itemLinks).where(eq(itemLinks.id, id));
    await logEvent({ entityType: "item_link", entityId: id, action: "deleted", summary: `${row?.kind ?? "link"} "${row?.title ?? id}" removed` }, tx);
  });
  if (row?.storageKey) await releaseStoredFiles(db, [row.storageKey]);
  return { ok: true as const };
}

export interface CatalogRow {
  source: "photo" | "capture";
  id: number;
  captureId: number | null;
  storageKey: string | null;
  title: string | null;
  createdAt: Date;
  itemId: number | null;
  itemName: string | null;
  itemStatus: "active" | "archived" | null;
  captureStatus: string | null;
  roomId: number | null;
  roomName: string | null;
  floor: string | null;
  houseId: number | null;
  areaName: string | null;
  isItemCover: boolean;
  /** a crop of a Thing (cropBox set): never a camera */
  isCutout: boolean;
  /** where the photo stands on its room's plan (photos.camera); null for captures */
  camera: PhotoCamera | null;
}

/** The Photos page catalog: every photo whatever its state (item photo,
 * location photo, bare photo made pinnable), plus every inbox image capture
 * that no photo was made from yet, newest first. */
export async function listPhotoCatalog(db: Db): Promise<CatalogRow[]> {
  const all = await db.select().from(photos).orderBy(desc(photos.createdAt));
  const itemIds = [...new Set(all.map((p) => p.itemId).filter((id): id is number => id != null))];
  const allItems = itemIds.length ? await db.select().from(items).where(inArray(items.id, itemIds)) : [];
  const itemById = new Map(allItems.map((i) => [i.id, i]));
  const areaById = new Map((await db.select().from(areas)).map((a) => [a.id, a]));
  const roomsById = await roomSummary(
    db,
    [...allItems.map((i) => i.roomId), ...all.map((p) => p.roomId)].filter((x): x is number => x != null),
  );
  const covers = await coverPhotos(db, itemIds);

  const photoRows: CatalogRow[] = all.map((p) => {
    const it = p.itemId != null ? itemById.get(p.itemId) : undefined;
    const roomId = it?.roomId ?? p.roomId ?? null;
    const room = roomId != null ? roomsById.get(roomId) : undefined;
    return {
      source: "photo",
      id: p.id,
      captureId: null,
      storageKey: p.storageKey,
      title: p.title ?? null,
      createdAt: p.createdAt,
      itemId: p.itemId ?? null,
      itemName: it?.name ?? null,
      itemStatus: it?.status ?? null,
      captureStatus: null,
      roomId,
      roomName: room?.name ?? null,
      floor: room?.floor ?? null,
      houseId: room?.houseId ?? it?.houseId ?? null,
      areaName: it ? (areaById.get(it.areaId)?.name ?? null) : null,
      isItemCover: p.itemId != null && covers.get(p.itemId)?.id === p.id,
      isCutout: p.cropBox != null,
      camera: p.camera ?? null,
    };
  });

  const filedCaptureIds = new Set(all.map((p) => p.sourceCaptureId).filter((id): id is number => id != null));
  const imageCaptures = await db.select().from(captures).where(eq(captures.kind, "image")).orderBy(desc(captures.createdAt));
  const captureRows: CatalogRow[] = imageCaptures
    .filter((c) => !filedCaptureIds.has(c.id))
    .map((c) => ({
      source: "capture",
      id: c.id,
      captureId: c.id,
      storageKey: c.storageKey,
      title: null,
      createdAt: c.createdAt,
      itemId: null,
      itemName: null,
      itemStatus: null,
      captureStatus: c.status,
      roomId: null,
      roomName: null,
      floor: null,
      houseId: null,
      areaName: null,
      isItemCover: false,
      isCutout: false,
      camera: null,
    }));

  return [...photoRows, ...captureRows].sort((a, b) => +b.createdAt - +a.createdAt);
}

/** One row in the pre-consolidation `attachments` shape, for the deprecated
 * attachments.* aliases, the wiki and the AI context. item_links ids are
 * NEGATED so a number never means both a photo and a link. */
export interface LegacyAttachment {
  id: number;
  itemId: number | null;
  areaId: number | null;
  roomId: number | null;
  kind: "image" | ItemLinkKind;
  title: string | null;
  content: string | null;
  url: string | null;
  storageKey: string | null;
  mimeType: string | null;
  size: number | null;
  sourceCaptureId: number | null;
  cropBox: CropBox | null;
  createdAt: Date;
}

export function photoAsLegacy(p: Photo): LegacyAttachment {
  return {
    id: p.id,
    itemId: p.itemId,
    areaId: p.areaId,
    roomId: p.roomId,
    kind: "image",
    title: p.title,
    content: null,
    url: null,
    storageKey: p.storageKey,
    mimeType: p.mimeType,
    size: p.size,
    sourceCaptureId: p.sourceCaptureId,
    cropBox: p.cropBox ?? null,
    createdAt: p.createdAt,
  };
}

export function linkAsLegacy(l: ItemLink): LegacyAttachment {
  return {
    id: -l.id,
    itemId: l.itemId,
    areaId: l.areaId,
    roomId: null,
    kind: l.kind,
    title: l.title,
    content: l.content,
    url: l.url,
    storageKey: l.storageKey,
    mimeType: l.mimeType,
    size: l.size,
    sourceCaptureId: l.sourceCaptureId,
    cropBox: null,
    createdAt: l.createdAt,
  };
}

export async function legacyAttachmentsForItem(db: Db, itemId: number): Promise<LegacyAttachment[]> {
  const pics = await db.select().from(photos).where(eq(photos.itemId, itemId));
  const links = await db.select().from(itemLinks).where(eq(itemLinks.itemId, itemId));
  return [...pics.map(photoAsLegacy), ...links.map(linkAsLegacy)].sort(
    (a, b) => +b.createdAt - +a.createdAt || b.id - a.id,
  );
}

/** Attach a bucket photo (a location photo, a bare photo) to an existing
 * Thing. A capture is never attached directly: the caller makes its photo
 * with photos.ensureForCapture first. A photo of another Thing moves only
 * with force (the UI asks "Move from X?"). The photo keeps its own room
 * (where it was taken); only a room-less photo takes the Thing's room. Pins
 * and cover photos are not touched: the cover is read from the item's photos.
 * A photo with pins on other Things is a scene, not this Thing's photo: it is
 * never attached (not even with force); pin the Thing in it instead. With
 * force, fromItemId (the owner the user agreed to move from, sent back as
 * the CONFLICT's ownerId) makes the move happen only while that is still the
 * owner. */
export async function attachPhotoToItem(
  db: Db,
  input: { photoId: number; itemId: number; force?: boolean; fromItemId?: number },
): Promise<{ photoId: number; itemId: number; roomId: number | null }> {
  const photo = await db.query.photos.findFirst({ where: eq(photos.id, input.photoId) });
  if (!photo) throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found." });
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: "Thing not found." });
  if (item.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: `"${item.name}" is archived.` });
  if (photo.itemId === item.id) return { photoId: photo.id, itemId: item.id, roomId: photo.roomId };
  const otherPins = await db
    .selectDistinct({ itemId: photoPins.itemId })
    .from(photoPins)
    .where(and(eq(photoPins.photoId, photo.id), isNotNull(photoPins.itemId), ne(photoPins.itemId, item.id)));
  if (otherPins.length) {
    const n = otherPins.length;
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This photo shows ${n} other ${n === 1 ? "Thing" : "Things"}; pin ${item.name} in it instead.`,
    });
  }
  if (photo.itemId != null && !input.force) {
    const owner = await db.query.items.findFirst({ where: eq(items.id, photo.itemId) });
    throw new TRPCError({
      code: "CONFLICT",
      message: `Photo belongs to ${owner?.name ?? `#${photo.itemId}`}`,
      cause: { ownerId: photo.itemId },
    });
  }
  const roomId = photo.roomId ?? item.roomId ?? null;
  await db.transaction(async (tx) => {
    // without force, only a photo that is still free (or already ours) is
    // taken: of two attaches racing for the same photo, one wins and the
    // other gets CONFLICT instead of silently moving it
    // with force and fromItemId, the move happens only while that Thing
    // still owns the photo: the user agreed to move it from that one
    const where = input.force
      ? input.fromItemId != null
        ? and(eq(photos.id, photo.id), eq(photos.itemId, input.fromItemId))
        : eq(photos.id, photo.id)
      : and(eq(photos.id, photo.id), or(isNull(photos.itemId), eq(photos.itemId, item.id)));
    // a camera lives in its room's frame: it stays only while the room does
    const [res] = await tx
      .update(photos)
      .set({ itemId: item.id, roomId, ...(roomId !== photo.roomId ? { camera: null } : {}) })
      .where(where);
    if ((!input.force || input.fromItemId != null) && res.affectedRows === 0) {
      throw new TRPCError({ code: "CONFLICT", message: "Photo was just attached to another Thing." });
    }
    await logEvent(
      {
        entityType: "item",
        entityId: item.id,
        action: "photo.attached",
        summary: `Photo "${photo.title ?? photo.id}" attached to "${item.name}"${photo.itemId != null ? ` (moved from item #${photo.itemId})` : ""}`,
        payload: { photoId: photo.id, fromItemId: photo.itemId ?? null, roomId },
      },
      tx,
    );
  });
  return { photoId: photo.id, itemId: item.id, roomId };
}

export const CAMERA_FOV_DEFAULT = 60;
export const CAMERA_HEIGHT_DEFAULT = 1.5;
/** how far inside the walls suggestCamera keeps a camera, in metres */
const CAMERA_WALL_MARGIN_M = 0.3;

/** Degrees into [0, 360). */
export function normaliseHeading(deg: number): number {
  const d = deg % 360;
  const n = d < 0 ? d + 360 : d;
  return n >= 360 ? 0 : n;
}

const round = (n: number, places: number) => +n.toFixed(places);

/** The photo a camera may be set on: a full photo (not a cutout) with a
 * room, and that room (for its size). */
async function cameraTarget(db: Db, photoId: number) {
  const photo = await db.query.photos.findFirst({ where: eq(photos.id, photoId) });
  if (!photo) throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found." });
  if (photo.cropBox != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A cutout is a crop of a Thing, not a viewpoint: it has no camera." });
  }
  if (photo.roomId == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Give the photo a room first: a camera stands in its room." });
  }
  const room = await db.query.rooms.findFirst({ where: eq(rooms.id, photo.roomId) });
  if (!room) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The photo's room no longer exists." });
  return { photo, room };
}

/** Put a photo's camera on its room's plan, or take it off (null). Inside
 * the room when the room has both width and depth; heading normalised to
 * [0, 360). Logs photo.camera on the photo's Thing, else on its room. */
export async function setPhotoCamera(
  db: Db,
  input: { id: number; camera: PhotoCamera | null },
): Promise<{ id: number; camera: PhotoCamera | null }> {
  const { photo, room } = await cameraTarget(db, input.id);
  let camera: PhotoCamera | null = null;
  if (input.camera) {
    const c = input.camera;
    if (room.widthM != null && room.depthM != null && (c.xM > room.widthM || c.yM > room.depthM)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `The camera is outside "${room.name}" (${room.widthM} x ${room.depthM} m).`,
      });
    }
    camera = { xM: c.xM, yM: c.yM, headingDeg: normaliseHeading(c.headingDeg), fovDeg: c.fovDeg, heightM: c.heightM };
  }
  await db.transaction(async (tx) => {
    await tx.update(photos).set({ camera }).where(eq(photos.id, photo.id));
    const label = photo.title ?? `#${photo.id}`;
    await logEvent(
      {
        ...(photo.itemId != null ? { entityType: "item", entityId: photo.itemId } : { entityType: "room", entityId: room.id }),
        action: "photo.camera",
        summary: camera
          ? `Photo "${label}" placed on the plan of "${room.name}" at ${camera.xM}, ${camera.yM} m facing ${camera.headingDeg}°`
          : `Photo "${label}" taken off the plan of "${room.name}"`,
        payload: { photoId: photo.id, roomId: room.id, camera },
      },
      tx,
    );
  });
  return { id: photo.id, camera };
}

/** A starting camera for a photo. With confirmed pins whose Things are
 * placed in the photo's room: c = the centroid of those Things' centres;
 * the camera stands where the ray from c through the room's centre leaves
 * the room (the wall point opposite c), kept 0.3 m inside the walls, and
 * faces c (basis "pins"). Without: the room's centre, facing +x (basis
 * "center"). Heading 0 = +x, counter-clockwise seen from above; yM grows
 * "down" the plan, so a direction (dx, dy) in room metres is atan2(-dy, dx).
 * Needs the room's width and depth. Writes nothing. */
export async function suggestPhotoCamera(db: Db, photoId: number): Promise<{ camera: PhotoCamera; basis: "pins" | "center" }> {
  const { photo, room } = await cameraTarget(db, photoId);
  const W = room.widthM ?? 0;
  const D = room.depthM ?? 0;
  if (!(W > 0 && D > 0)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `"${room.name}" has no size yet: there is no plan to stand on.` });
  }
  const base = { fovDeg: CAMERA_FOV_DEFAULT, heightM: CAMERA_HEIGHT_DEFAULT };
  const centre = { x: W / 2, y: D / 2 };

  const placed = await db
    .selectDistinct({ itemId: items.id, pos: items.pos })
    .from(photoPins)
    .innerJoin(items, eq(items.id, photoPins.itemId))
    .where(and(eq(photoPins.photoId, photo.id), eq(photoPins.status, "confirmed"), eq(items.roomId, room.id), isNotNull(items.pos)));
  const centres = placed
    .map((r) => r.pos as ItemPos | null)
    .filter((p): p is ItemPos => p != null)
    .map((p) => ({ x: p.xM + p.wM / 2, y: p.yM + p.dM / 2 }));
  if (!centres.length) {
    return { camera: { xM: round(centre.x, 2), yM: round(centre.y, 2), headingDeg: 0, ...base }, basis: "center" };
  }

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const c = {
    x: clamp(centres.reduce((s, p) => s + p.x, 0) / centres.length, 0, W),
    y: clamp(centres.reduce((s, p) => s + p.y, 0) / centres.length, 0, D),
  };
  // the ray from c through the centre; with c on the centre, look from the -x wall
  let ux = centre.x - c.x;
  let uy = centre.y - c.y;
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) {
    ux = -1;
    uy = 0;
  } else {
    ux /= len;
    uy /= len;
  }
  // distance along the ray to the first wall it meets
  const tx = ux > 0 ? (W - c.x) / ux : ux < 0 ? -c.x / ux : Infinity;
  const ty = uy > 0 ? (D - c.y) / uy : uy < 0 ? -c.y / uy : Infinity;
  const t = Math.min(tx, ty);
  const inset = (v: number, size: number) =>
    size > 2 * CAMERA_WALL_MARGIN_M ? clamp(v, CAMERA_WALL_MARGIN_M, size - CAMERA_WALL_MARGIN_M) : size / 2;
  const cam = { x: inset(c.x + t * ux, W), y: inset(c.y + t * uy, D) };
  const dx = c.x - cam.x;
  const dy = c.y - cam.y;
  const headingDeg = Math.hypot(dx, dy) < 1e-6 ? 0 : normaliseHeading(round((Math.atan2(-dy, dx) * 180) / Math.PI, 1));
  return { camera: { xM: round(cam.x, 2), yM: round(cam.y, 2), headingDeg, ...base }, basis: "pins" };
}
