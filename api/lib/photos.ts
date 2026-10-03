// api/lib/photos.ts
// Shared reads and writes for photos (images) and item_links (link, note,
// file). The photos/pins/itemLinks routers and the deprecated attachments.*
// aliases all go through these, so each table is written one way.
import { asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { areas, captures, itemLinks, items, photoPins, photos, type CropBox, type ItemLink, type Photo } from "@db/schema";
import type { getDb } from "../queries/connection";
import { readFileBytes } from "./filestore";
import { sniffMime } from "./sniff";
import { logEvent } from "./events";
import { releaseStoredFiles } from "./entities";
import { roomSummary } from "./location";

type Db = ReturnType<typeof getDb>;

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
