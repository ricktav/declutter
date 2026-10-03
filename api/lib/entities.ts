import { eq, or, and, inArray } from "drizzle-orm";
import {
  items,
  photos,
  photoPins,
  itemLinks,
  relations,
  ideaItems,
  tasks,
  measurements,
  chatMessages,
  captures,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { deleteStoredFile } from "./filestore";
import { logEvent } from "./events";

type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Delete one item and everything that only makes sense with it, inside the
 * caller's transaction. Files are returned, not deleted, so the caller can
 * remove them after the transaction committed.
 */
export async function deleteItemTx(tx: Tx, id: number, opts: { summary?: string } = {}): Promise<string[]> {
  const item = await tx.query.items.findFirst({ where: eq(items.id, id) });
  const ownPhotos = await tx.select({ id: photos.id, storageKey: photos.storageKey }).from(photos).where(eq(photos.itemId, id));
  const ownLinks = await tx.select({ storageKey: itemLinks.storageKey }).from(itemLinks).where(eq(itemLinks.itemId, id));

  await tx.update(items).set({ parentId: null }).where(eq(items.parentId, id));
  await tx.delete(relations).where(or(eq(relations.fromItemId, id), eq(relations.toItemId, id)));
  // pins drawn ON this item's photos go with the photos; pins on other
  // photos that point AT this item only lose the link
  if (ownPhotos.length) await tx.delete(photoPins).where(inArray(photoPins.photoId, ownPhotos.map((p) => p.id)));
  await tx.update(photoPins).set({ itemId: null }).where(eq(photoPins.itemId, id));
  await tx.update(tasks).set({ itemId: null }).where(eq(tasks.itemId, id));
  await tx.delete(ideaItems).where(eq(ideaItems.itemId, id));
  await tx.delete(measurements).where(and(eq(measurements.targetType, "item"), eq(measurements.targetId, id)));
  await tx.delete(chatMessages).where(and(eq(chatMessages.scope, "item"), eq(chatMessages.scopeId, id)));
  await tx.delete(itemLinks).where(eq(itemLinks.itemId, id));
  await tx.delete(photos).where(eq(photos.itemId, id));
  await tx.delete(items).where(eq(items.id, id));
  await logEvent(
    {
      entityType: "item",
      entityId: id,
      action: "deleted",
      summary: opts.summary ?? `Item "${item?.name ?? id}" deleted`,
    },
    tx,
  );
  return [...ownPhotos.map((p) => p.storageKey), ...ownLinks.map((l) => l.storageKey)].filter((k): k is string => !!k);
}

/**
 * Delete stored files only when no other row still points at them. Rows
 * written before phase 1 can share one file between a capture and a
 * photo, so a plain delete would take the inbox photo with it.
 */
export async function releaseStoredFiles(db: Db, keys: string[]): Promise<number> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return 0;
  const stillUsed = new Set<string>();
  for (const row of await db.select({ k: photos.storageKey }).from(photos).where(inArray(photos.storageKey, unique))) {
    stillUsed.add(row.k);
  }
  for (const row of await db.select({ k: itemLinks.storageKey }).from(itemLinks).where(inArray(itemLinks.storageKey, unique))) {
    if (row.k) stillUsed.add(row.k);
  }
  for (const row of await db.select({ k: captures.storageKey }).from(captures).where(inArray(captures.storageKey, unique))) {
    if (row.k) stillUsed.add(row.k);
  }
  let removed = 0;
  for (const k of unique) {
    if (stillUsed.has(k)) continue;
    await deleteStoredFile(k).catch(() => {});
    removed++;
  }
  return removed;
}
