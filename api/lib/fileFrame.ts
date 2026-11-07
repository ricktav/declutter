// api/lib/fileFrame.ts
// One frame on a photo becomes a Thing: the Thing (new, or an existing one),
// its Decision and a confirmed pin are written in one transaction; the cutout
// is cropped after the commit and is best-effort (cutoutError reports a
// failure, the Thing and pin stay). photos.fileFrame; Focus and Annotate.
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { items, photoPins, photos, type CropBox, type ItemDecision } from "@db/schema";
import type { getDb } from "../queries/connection";
import { defaultAreaId } from "./defaultTopic";
import { logEvent } from "./events";
import { setItemLocation } from "./location";
import { stampIpRefresh } from "./ipRefresh";
import { createCutoutFor, ensurePinForCutout } from "./photos";
import { suggestLinksForNewItem } from "./suggestLinks";

type Db = ReturnType<typeof getDb>;

export interface FileFrameInput {
  /** the photo the frame is drawn on */
  sourcePhotoId: number;
  box: CropBox;
  /** an existing Thing, or null for a new one (then itemName is required) */
  itemId: number | null;
  itemName?: string;
  description?: string;
  /** omitted: the default "Things" topic */
  areaId?: number;
  roomId?: number | null;
  houseId?: number | null;
  /** a pin already on the photo (a suggestion, a drawn frame) to link instead of adding one */
  pinId?: number;
  /** the pin's label; defaults to the Thing's name */
  label?: string;
  /** set on the Thing in the same transaction; null or omitted leaves it as it is */
  decision?: ItemDecision | null;
  /** default false; true runs items.create's link suggestions for a new Thing */
  suggestLinks?: boolean;
  photoSize?: "small" | "medium" | "big";
}

export interface FileFrameResult {
  itemId: number;
  pinId: number;
  /** the cutout, or null when cropping failed */
  photoId: number | null;
  createdItem: boolean;
  createdPhoto: boolean;
  cutoutError: string | null;
}

export async function fileFrame(db: Db, ctxHouseId: number | null, input: FileFrameInput): Promise<FileFrameResult> {
  const newName = input.itemName?.trim() ?? "";
  if (input.itemId == null && !newName) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A new Thing needs a name." });
  }
  const source = await db.query.photos.findFirst({ where: eq(photos.id, input.sourcePhotoId) });
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source photo not found." });
  // like items.create: the topic is found (or made) before the transaction
  const newAreaId = input.itemId == null ? (input.areaId ?? (await defaultAreaId(db))) : null;

  const saved = await db.transaction(async (tx) => {
    let itemId: number;
    let name: string;
    let areaId: number;
    if (input.itemId == null) {
      areaId = newAreaId!;
      name = newName;
      const attributes = stampIpRefresh(null, null);
      const [{ id }] = await tx
        .insert(items)
        .values({
          areaId,
          name,
          description: input.description ?? null,
          attributes,
          parentId: null,
          houseId: input.houseId ?? ctxHouseId ?? null,
          roomId: null,
          verificationStatus: "confirmed",
        })
        .$returningId();
      itemId = id;
      if (input.roomId != null) await setItemLocation(tx, itemId, { roomId: input.roomId });
      await logEvent(
        {
          entityType: "item",
          entityId: itemId,
          action: "created",
          summary: `Item "${name}" created`,
          payload: { areaId, attributes },
        },
        tx,
      );
    } else {
      const item = await tx.query.items.findFirst({ where: eq(items.id, input.itemId) });
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found." });
      itemId = item.id;
      name = item.name;
      areaId = item.areaId;
    }

    if (input.decision) {
      await tx.update(items).set({ decision: input.decision, decidedAt: new Date() }).where(eq(items.id, itemId));
      await logEvent(
        {
          entityType: "item",
          entityId: itemId,
          action: `decision:${input.decision}`,
          summary: `Item "${name}" marked ${input.decision}`,
        },
        tx,
      );
    }

    let pinId: number;
    if (input.pinId != null) {
      const pin = await tx.query.photoPins.findFirst({ where: eq(photoPins.id, input.pinId) });
      if (!pin) throw new TRPCError({ code: "NOT_FOUND", message: "Pin not found." });
      if (pin.photoId !== input.sourcePhotoId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That pin is on another photo." });
      }
      await tx
        .update(photoPins)
        .set({ itemId, label: (input.label ?? name).slice(0, 255), status: "confirmed" })
        .where(eq(photoPins.id, pin.id));
      pinId = pin.id;
    } else {
      ({ id: pinId } = await ensurePinForCutout(tx, { sourcePhotoId: input.sourcePhotoId, itemId, box: input.box, label: name }));
    }
    return { itemId, name, areaId, pinId };
  });

  // the Thing and its pin are saved: a crop that fails is reported, not thrown
  let photoId: number | null = null;
  let createdPhoto = false;
  let cutoutError: string | null = null;
  try {
    // a frame thinner than 1% keeps its Thing and pin but makes no cutout
    if (input.box.wPct < 1 || input.box.hPct < 1) throw new Error("Frame is too thin to crop (under 1%).");
    const cut = await createCutoutFor(db, {
      itemId: saved.itemId,
      sourcePhotoId: input.sourcePhotoId,
      box: input.box,
      photoSize: input.photoSize ?? "big",
    });
    photoId = cut.id;
    createdPhoto = cut.created;
  } catch (err) {
    cutoutError = err instanceof Error ? err.message : String(err);
  }

  const createdItem = input.itemId == null;
  if (createdItem && input.suggestLinks === true) {
    try {
      await suggestLinksForNewItem(db, { id: saved.itemId, name: saved.name, description: input.description, areaId: saved.areaId });
    } catch {
      // suggestions are best-effort: the Thing is already saved
    }
  }

  return { itemId: saved.itemId, pinId: saved.pinId, photoId, createdItem, createdPhoto, cutoutError };
}
