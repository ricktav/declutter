// api/lib/photos.ts
// Shared reads and writes for photos (images) and item_links (link, note,
// file). The photos/pins/itemLinks routers and the deprecated attachments.*
// aliases all go through these, so each table is written one way.
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { areas, captures, itemLinks, items, photoPins, photos, type CropBox, type ItemLink, type Photo } from "@db/schema";
import type { getDb } from "../queries/connection";
import { readFileBytes, withNewFile } from "./filestore";
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
  input: { sourcePhotoId: number; itemId: number; box: PinBox; label: string },
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
      summary: `Pin "${input.label || "untitled"}" added to photo #${input.sourcePhotoId} for the cutout of item #${input.itemId}`,
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
  return db.transaction(async (tx) => {
    // Lock the capture row first: a second call for the same capture waits
    // here. Its plain read below runs after the first call committed, so it
    // finds that photo instead of making another one.
    const [cap] = await tx.select().from(captures).where(eq(captures.id, captureId)).for("update");
    const existing = await tx.query.photos.findFirst({
      where: and(eq(photos.sourceCaptureId, captureId), isNull(photos.itemId)),
    });
    if (existing) {
      // a room confirmed just now (Inbox's pending-item "Pin" flow) is worth keeping
      if (roomId != null && existing.roomId == null) {
        await tx.update(photos).set({ roomId }).where(eq(photos.id, existing.id));
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
    return withNewFile(
      { bytes, fileName: `locations/${cap.storageKey.split("/").pop() ?? "photo"}`, contentType: mimeType },
      async (copy) => {
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
      },
    );
  });
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
  await db
    .update(photos)
    .set({ itemId: null, roomId: photo.roomId ?? item?.roomId ?? null })
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
