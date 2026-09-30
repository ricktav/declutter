import { z } from "zod";
import { eq, and, or, desc, isNotNull } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { attachments, photoAnnotations, captures, items, areas, type CropBox } from "@db/schema";
import { putFile, deleteStoredFile, readFileBytes, urlForKey } from "../lib/filestore";
import { cropPercent } from "../lib/crop";
import { logEvent } from "../lib/events";

const cropBoxInput = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  wPct: z.number().min(1).max(100),
  hPct: z.number().min(1).max(100),
});

export const attachmentsRouter = createRouter({
  add: publicQuery
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        kind: z.enum(["image", "link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        contentBase64: z.string().max(14_000_000).optional(), // ~10MB file
        mimeType: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      let storageKey: string | null = null;
      let size: number | null = null;

      if ((input.kind === "image" || input.kind === "file") && input.contentBase64) {
        const bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
        const saved = await putFile({
          bytes,
          fileName: `attachments/${input.fileName ?? "file"}`,
          contentType: input.mimeType,
        });
        storageKey = saved.key;
        size = saved.size;
      }

      const [{ id }] = await db
        .insert(attachments)
        .values({
          itemId: input.itemId ?? null,
          areaId: input.areaId ?? null,
          kind: input.kind,
          title: input.title ?? null,
          content: input.content ?? null,
          url: input.url ?? null,
          storageKey,
          mimeType: input.mimeType ?? null,
          size,
        })
        .$returningId();
      await logEvent({
        entityType: "attachment",
        entityId: id,
        action: "created",
        summary: `${input.kind} attachment "${input.title ?? input.fileName ?? input.url ?? "note"}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
        payload: { itemId: input.itemId, areaId: input.areaId, kind: input.kind },
      });
      return { id, storageKey };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, input.id) });
    if (row?.storageKey) {
      await deleteStoredFile(row.storageKey);
    }
    await db.delete(photoAnnotations).where(eq(photoAnnotations.attachmentId, input.id));
    await db.delete(attachments).where(eq(attachments.id, input.id));
    await logEvent({
      entityType: "attachment",
      entityId: input.id,
      action: "deleted",
      summary: `Attachment "${row?.title ?? input.id}" removed`,
    });
    return { ok: true };
  }),

  url: publicQuery.input(z.object({ key: z.string() })).query(async ({ input }) => {
    return { url: await urlForKey(input.key) };
  }),

  urlForAttachment: publicQuery
    .input(z.object({ attachmentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({
        where: eq(attachments.id, input.attachmentId),
      });
      if (!att) return { attachment: null, url: null };
      if (!att.storageKey) return { attachment: att, url: null };
      return { attachment: att, url: await urlForKey(att.storageKey) };
    }),

  listForItem: publicQuery.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.itemId, input.itemId))
      .orderBy(desc(attachments.createdAt)),
  ),

  /** The original photo a cutout was cropped from, plus its current box — for a re-crop UI. */
  sourcePhoto: publicQuery
    .input(z.object({ attachmentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({ where: eq(attachments.id, input.attachmentId) });
      if (!att?.sourceCaptureId) return { available: false as const };
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, att.sourceCaptureId) });
      if (!cap?.storageKey) return { available: false as const };
      return {
        available: true as const,
        url: await urlForKey(cap.storageKey),
        cropBox: att.cropBox as CropBox | null,
      };
    }),

  /** Re-crop a cutout from its original source photo with a new box — replaces the image in place. */
  recrop: publicQuery
    .input(z.object({ attachmentId: z.number(), box: cropBoxInput }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({ where: eq(attachments.id, input.attachmentId) });
      if (!att?.sourceCaptureId) throw new Error("This cutout has no source photo to re-crop from.");
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, att.sourceCaptureId) });
      if (!cap?.storageKey) throw new Error("Source photo is no longer available.");

      const bytes = await readFileBytes(cap.storageKey);
      const cropped = await cropPercent(bytes, input.box);
      const saved = await putFile({
        bytes: new Uint8Array(cropped),
        fileName: `items/${att.itemId ?? "attachment"}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      const oldKey = att.storageKey;
      await db
        .update(attachments)
        .set({ storageKey: saved.key, size: saved.size, cropBox: input.box })
        .where(eq(attachments.id, input.attachmentId));
      if (oldKey) await deleteStoredFile(oldKey);
      await logEvent({
        entityType: "attachment",
        entityId: input.attachmentId,
        action: "recropped",
        summary: `Cutout "${att.title ?? input.attachmentId}" re-cropped from its source photo`,
      });
      return { ok: true, storageKey: saved.key };
    }),

  /** Give a freshly-created item its first photo: crop a box out of the
   * attachment being annotated (its original source capture when it has
   * one, otherwise the attachment's own image) so pinning a new object
   * doesn't leave it imageless. */
  createCutoutFromAttachment: publicQuery
    .input(z.object({ itemId: z.number(), sourceAttachmentId: z.number(), box: cropBoxInput }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const source = await db.query.attachments.findFirst({ where: eq(attachments.id, input.sourceAttachmentId) });
      if (!source) throw new Error("Source photo not found.");

      let bytes: Uint8Array;
      let sourceCaptureId: number | null = null;
      if (source.sourceCaptureId) {
        const cap = await db.query.captures.findFirst({ where: eq(captures.id, source.sourceCaptureId) });
        if (!cap?.storageKey) throw new Error("Source photo is no longer available.");
        bytes = await readFileBytes(cap.storageKey);
        sourceCaptureId = cap.id;
      } else if (source.storageKey) {
        bytes = await readFileBytes(source.storageKey);
      } else {
        throw new Error("Source photo is no longer available.");
      }

      // this item already has a photo from this same original photo (e.g.
      // pinning it again, or re-saving an edit) - don't pile up duplicates
      if (sourceCaptureId) {
        const dup = await db.query.attachments.findFirst({
          where: and(eq(attachments.itemId, input.itemId), eq(attachments.sourceCaptureId, sourceCaptureId)),
        });
        if (dup) return { id: dup.id, storageKey: dup.storageKey, created: false as const };
      }

      const cropped = await cropPercent(bytes, input.box);
      const saved = await putFile({
        bytes: new Uint8Array(cropped),
        fileName: `items/${input.itemId}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      const [{ id }] = await db
        .insert(attachments)
        .values({
          itemId: input.itemId,
          kind: "image",
          storageKey: saved.key,
          mimeType: "image/jpeg",
          size: saved.size,
          sourceCaptureId,
          cropBox: input.box,
          title: "Photo",
        })
        .$returningId();
      await logEvent({
        entityType: "attachment",
        entityId: id,
        action: "created",
        summary: `Photo cropped from pin location and added to item #${input.itemId}`,
      });
      return { id, storageKey: saved.key, created: true as const };
    }),

  /** Every photo attached to an item, across the whole inventory - the
   * "photo catalog" (Photos page), groupable/filterable by location since
   * that's what actually varies photo to photo, not the item's other
   * attributes. */
  listAllImages: publicQuery.query(async () => {
    const db = getDb();
    // an item's own photo, or a photo whose location was confirmed before
    // any item existed yet (Inbox's pending-item "Pin" flow) - either way
    // it belongs in the catalog, grouped by whatever location it has
    const atts = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.kind, "image"), or(isNotNull(attachments.itemId), isNotNull(attachments.room))))
      .orderBy(desc(attachments.createdAt));
    const itemIds = [...new Set(atts.map((a) => a.itemId).filter((id): id is number => id != null))];
    const allItems = itemIds.length
      ? await db.select().from(items).where(or(...itemIds.map((id) => eq(items.id, id))))
      : [];
    const itemById = new Map(allItems.map((i) => [i.id, i]));
    const allAreas = await db.select().from(areas);
    const areaById = new Map(allAreas.map((a) => [a.id, a]));
    return atts.map((a) => {
      const it = a.itemId != null ? itemById.get(a.itemId) : undefined;
      return {
        id: a.id,
        storageKey: a.storageKey,
        createdAt: a.createdAt,
        itemId: a.itemId ?? null,
        itemName: it?.name ?? null,
        itemStatus: it?.status ?? null,
        houseId: it?.houseId ?? a.houseId ?? null,
        floor: it?.floor ?? a.floor ?? null,
        room: it?.room ?? a.room ?? null,
        areaName: it ? (areaById.get(it.areaId)?.name ?? null) : null,
      };
    });
  }),
});
