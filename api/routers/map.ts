import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { items, attachments, captures } from "@db/schema";
import { logEvent } from "../lib/events";
import { copyStoredFile } from "../lib/filestore";

/**
 * Location-first entry point onto the same SSOT the item workbench uses -
 * see architecture artifact §07. A "location" is a room (roomId), the same
 * link every item already carries; no new geometry concept.
 */
export const mapRouter = createRouter({
  /**
   * The photo pool for a location - every distinct source photo behind that
   * location's items. Derived from cutout provenance (sourceCaptureId), not
   * a manual tagging step: it grows automatically as the inbox pipeline
   * files more items there.
   */
  photosForLocation: procedure
    .input(z.object({ roomId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const locItems = await db
        .select({ id: items.id })
        .from(items)
        .where(
          and(eq(items.status, "active"), eq(items.roomId, input.roomId)),
        );
      if (!locItems.length) return [];
      const itemIds = new Set(locItems.map((i) => i.id));

      const atts = await db.select().from(attachments).where(eq(attachments.kind, "image"));
      const captureIds = new Set<number>();
      for (const a of atts) {
        if (a.itemId && itemIds.has(a.itemId) && a.sourceCaptureId) captureIds.add(a.sourceCaptureId);
      }
      if (!captureIds.size) return [];

      const allCaptures = await db.select().from(captures);
      return allCaptures
        .filter((c) => captureIds.has(c.id) && c.storageKey)
        .map((c) => ({ id: c.id, storageKey: c.storageKey! }));
    }),

  /**
   * The pin canvas (/annotate/:attachmentId) works on an attachment, but a
   * pool photo is only a capture until now - nobody's attached it to
   * anything yet. Find-or-create a bare, itemId-less attachment for it
   * (one per capture, reused on repeat visits) so it becomes pinnable.
   */
  ensureAttachmentForCapture: procedure
    .input(
      z.object({
        captureId: z.number(),
        roomId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.attachments.findFirst({
        // itemId IS NULL is the key filter: a cutout also carries this same
        // sourceCaptureId (that's how the photo pool finds it in the first
        // place) but is cropped, not the full photo - without this filter
        // the query can return someone's cutout instead of materializing
        // the bare full-photo attachment this is meant to find/create
        where: and(
          eq(attachments.sourceCaptureId, input.captureId),
          eq(attachments.kind, "image"),
          isNull(attachments.itemId),
        ),
      });
      if (existing) {
        // a location confirmed just now (e.g. Inbox's pending-item "Pin"
        // flow) is worth saving onto an attachment that doesn't have one yet
        if (input.roomId != null && existing.roomId == null) {
          await db
            .update(attachments)
            .set({ roomId: input.roomId })
            .where(eq(attachments.id, existing.id));
        }
        return { attachmentId: existing.id };
      }

      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.captureId) });
      if (!cap?.storageKey) throw new Error("Capture has no stored photo.");

      // own copy of the bytes: a capture and an attachment never share a key
      const copy = await copyStoredFile(cap.storageKey, `locations/${cap.storageKey.split("/").pop() ?? "photo"}`);
      const [{ id }] = await db
        .insert(attachments)
        .values({
          kind: "image",
          storageKey: copy.key,
          size: copy.size,
          mimeType: "image/jpeg",
          sourceCaptureId: cap.id,
          roomId: input.roomId ?? null,
          title: "Location photo",
        })
        .$returningId();
      await logEvent({
        entityType: "attachment",
        entityId: id,
        action: "created",
        summary: `Location photo attachment created from capture #${cap.id} (via Map view)`,
      });
      return { attachmentId: id };
    }),
});
