import { z } from "zod";
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { items, attachments, captures, houses } from "@db/schema";
import { logEvent } from "../lib/events";

/**
 * Location-first entry point onto the same SSOT the item workbench uses -
 * see architecture artifact §07. A "location" is a (houseId, floor, room)
 * tuple, matching what every item already carries; no new geometry concept.
 */
export const mapRouter = createRouter({
  /** Every distinct location with at least one active item, for the picker. */
  listLocations: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ houseId: items.houseId, floor: items.floor, room: items.room })
      .from(items)
      .where(and(eq(items.status, "active"), isNotNull(items.room)));
    const allHouses = await db.select().from(houses);
    const houseById = new Map(allHouses.map((h) => [h.id, h]));

    const counts = new Map<string, { houseId: number | null; floor: string | null; room: string; count: number }>();
    for (const r of rows) {
      const key = `${r.houseId ?? 0}|${r.floor ?? ""}|${r.room}`;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { houseId: r.houseId, floor: r.floor, room: r.room!, count: 1 });
    }
    return [...counts.values()]
      .map((l) => ({ ...l, houseName: l.houseId ? (houseById.get(l.houseId)?.name ?? null) : null }))
      .sort((a, b) => (a.houseName ?? "").localeCompare(b.houseName ?? "") || a.room.localeCompare(b.room));
  }),

  /**
   * The photo pool for a location - every distinct source photo behind that
   * location's items. Derived from cutout provenance (sourceCaptureId), not
   * a manual tagging step: it grows automatically as the inbox pipeline
   * files more items there.
   */
  photosForLocation: publicQuery
    .input(z.object({ houseId: z.number().nullable(), floor: z.string().nullable(), room: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const locItems = await db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.status, "active"),
            eq(items.room, input.room),
            input.houseId != null ? eq(items.houseId, input.houseId) : undefined,
            input.floor != null ? eq(items.floor, input.floor) : undefined,
          ),
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
  ensureAttachmentForCapture: publicQuery
    .input(z.object({ captureId: z.number(), houseId: z.number().nullable() }))
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
      if (existing) return { attachmentId: existing.id };

      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.captureId) });
      if (!cap?.storageKey) throw new Error("Capture has no stored photo.");

      const [{ id }] = await db
        .insert(attachments)
        .values({
          kind: "image",
          storageKey: cap.storageKey,
          mimeType: "image/jpeg",
          sourceCaptureId: cap.id,
          houseId: input.houseId,
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
