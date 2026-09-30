import { z } from "zod";
import { eq, or, desc } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { photoAnnotations, attachments, items, areas } from "@db/schema";
import { readFileBytes } from "../lib/filestore";
import { toThumbnail, cropPercent } from "../lib/crop";
import { getVisionModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";
import { logEvent } from "../lib/events";

function nameScore(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

const detectSchema = z.object({
  objects: z.array(
    z.object({
      label: z.string().describe("short name of the detected object"),
      xPct: z.number().min(0).max(100).describe("horizontal center, 0-100% of image width"),
      yPct: z.number().min(0).max(100).describe("vertical center, 0-100% of image height"),
      wPct: z.number().min(0).max(100).optional().describe("width of the bounding box, 0-100% of image width"),
      hPct: z.number().min(0).max(100).optional().describe("height of the bounding box, 0-100% of image height"),
      matchedItemId: z
        .number()
        .nullable()
        .describe(
          "if this object visually matches one of the reference photos shown above (same physical object, not just the same category), the exact item ID given in that photo's caption. Otherwise null - do not guess from the name alone.",
        ),
    }),
  ),
});

const MAX_REFERENCE_PHOTOS = 20;

const suggestSchema = z.object({
  label: z.string().describe("short, specific name of the object in the cropped photo"),
  matchedItemId: z
    .number()
    .nullable()
    .describe(
      "if this is the same physical object as one of the reference photos shown above (not just the same category), its exact item ID. Otherwise null - do not guess from the name alone.",
    ),
});

type RefContentPart = { type: "text"; text: string } | { type: "image"; image: Uint8Array };

/** Reference photos let the model recognize a re-photographed item by sight
 * instead of guessing from name text alone. */
async function buildReferenceContent(
  db: ReturnType<typeof getDb>,
  allItems: { id: number; name: string }[],
  limit: number,
): Promise<RefContentPart[]> {
  const photoRows = await db
    .select({ itemId: attachments.itemId, storageKey: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.kind, "image"));
  const photoByItem = new Map<number, string>();
  for (const p of photoRows) {
    if (p.itemId && p.storageKey && !photoByItem.has(p.itemId)) photoByItem.set(p.itemId, p.storageKey);
  }
  const refItems = allItems.filter((it) => photoByItem.has(it.id)).slice(0, limit);
  const refContent: RefContentPart[] = [];
  for (const it of refItems) {
    try {
      const refBytes = await toThumbnail(await readFileBytes(photoByItem.get(it.id)!));
      refContent.push({ type: "text", text: `Reference photo — existing item [id ${it.id}]: "${it.name}"` });
      refContent.push({ type: "image", image: refBytes });
    } catch {
      // file missing on disk — skip this one reference, not fatal
    }
  }
  return refContent;
}

export const annotationsRouter = createRouter({
  listForAttachment: publicQuery
    .input(z.object({ attachmentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const pins = await db
        .select()
        .from(photoAnnotations)
        .where(eq(photoAnnotations.attachmentId, input.attachmentId));
      const itemIds = [...new Set(pins.map((p) => p.itemId).filter((x): x is number => !!x))];
      const linked = itemIds.length
        ? await db.select().from(items).where(or(...itemIds.map((i) => eq(items.id, i))))
        : [];
      const nameMap = new Map(linked.map((i) => [i.id, i.name]));
      // area color, not just name - the pin marker's fill reflects the
      // linked item's category, so a "black desk lamp" and a "Sonos
      // speaker" read differently on the photo at a glance
      const allAreas = await db.select().from(areas);
      const areaColorById = new Map(allAreas.map((a) => [a.id, a.color]));
      const areaColorByItem = new Map(linked.map((i) => [i.id, areaColorById.get(i.areaId) ?? null]));
      return pins.map((p) => ({
        ...p,
        itemName: p.itemId ? (nameMap.get(p.itemId) ?? null) : null,
        itemAreaColor: p.itemId ? (areaColorByItem.get(p.itemId) ?? null) : null,
      }));
    }),

  /** items pinned anywhere (back-references for the item page) */
  listForItem: publicQuery.input(z.object({ itemId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const pins = await db
      .select()
      .from(photoAnnotations)
      .where(eq(photoAnnotations.itemId, input.itemId));
    const attIds = [...new Set(pins.map((p) => p.attachmentId))];
    const atts = attIds.length
      ? await db.select().from(attachments).where(or(...attIds.map((a) => eq(attachments.id, a))))
      : [];
    const attMap = new Map(atts.map((a) => [a.id, a]));
    return pins.map((p) => ({ ...p, attachment: attMap.get(p.attachmentId) ?? null }));
  }),

  add: publicQuery
    .input(
      z.object({
        attachmentId: z.number(),
        xPct: z.number().min(0).max(100),
        yPct: z.number().min(0).max(100),
        wPct: z.number().min(0).max(100).optional(),
        hPct: z.number().min(0).max(100).optional(),
        label: z.string().default(""),
        itemId: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(photoAnnotations)
        .values({
          attachmentId: input.attachmentId,
          xPct: input.xPct,
          yPct: input.yPct,
          wPct: input.wPct ?? null,
          hPct: input.hPct ?? null,
          label: input.label,
          itemId: input.itemId ?? null,
          origin: "user",
          status: "confirmed",
        })
        .$returningId();
      await logEvent({
        entityType: "annotation",
        entityId: id,
        action: "pin-added",
        summary: `Pin "${input.label || "untitled"}" added to photo #${input.attachmentId}`,
      });
      return { id };
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        label: z.string().optional(),
        itemId: z.number().nullable().optional(),
        xPct: z.number().min(0).max(100).optional(),
        yPct: z.number().min(0).max(100).optional(),
        wPct: z.number().min(0).max(100).optional(),
        hPct: z.number().min(0).max(100).optional(),
        flagged: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      await getDb().update(photoAnnotations).set(patch).where(eq(photoAnnotations.id, id));
      return { ok: true };
    }),

  resolve: publicQuery
    .input(
      z.object({
        id: z.number(),
        confirm: z.boolean(),
        label: z.string().optional(),
        itemId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      if (input.confirm) {
        const patch: Record<string, unknown> = { status: "confirmed" };
        if (input.label !== undefined) patch.label = input.label;
        if (input.itemId !== undefined) patch.itemId = input.itemId;
        await db.update(photoAnnotations).set(patch).where(eq(photoAnnotations.id, input.id));
      } else {
        await db.delete(photoAnnotations).where(eq(photoAnnotations.id, input.id));
      }
      await logEvent({
        entityType: "annotation",
        entityId: input.id,
        action: input.confirm ? "pin-confirmed" : "pin-rejected",
        summary: `AI pin #${input.id} ${input.confirm ? "confirmed" : "rejected"}`,
      });
      return { ok: true };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(photoAnnotations).where(eq(photoAnnotations.id, input.id));
    await logEvent({
      entityType: "annotation",
      entityId: input.id,
      action: "pin-removed",
      summary: `Pin #${input.id} removed`,
    });
    return { ok: true };
  }),

  /** AI: detect objects in the photo, match against inventory, suggest pins */
  detect: publicQuery
    .input(z.object({ attachmentId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({
        where: eq(attachments.id, input.attachmentId),
      });
      if (!att?.storageKey) {
        return { ok: false as const, error: "No stored image for this attachment." };
      }

      try {
        const bytes = await readFileBytes(att.storageKey);
        const allItems = await db
          .select()
          .from(items)
          .where(eq(items.status, "active"))
          .orderBy(desc(items.updatedAt));

        const refContent = await buildReferenceContent(db, allItems, MAX_REFERENCE_PHOTOS);

        const model = await getVisionModel();
        const { object } = await generateObject({
          model,
          schema: detectSchema,
          messages: [
            {
              role: "user",
              content: [
                ...refContent,
                {
                  type: "text",
                  text: `Identify the distinct physical objects worth inventorying in the PHOTO BELOW (devices, tools, containers, appliances, furniture — NOT wall, floor, ceiling, windows, or other background). List up to 15 of the most significant objects. Do not pad the list with duplicates, parts of already-listed objects, or background — fewer accurate objects is better than many vague ones.\n\nFor each object give a tight bounding box around the object itself: xPct/yPct is the box CENTER as a percentage of image width/height; wPct/hPct is the box width/height as a percentage of image width/height.\n\n${refContent.length ? "Some existing items' reference photos were shown above this message. If an object in the photo below is the SAME PHYSICAL OBJECT as one of those reference photos, set matchedItemId to its id — only if you actually recognize it visually, not from the name alone.\n\n" : ""}The user's full existing inventory (for name-based context only, not all of these have a reference photo):\n${allItems.slice(0, 200).map((i) => `- ${i.id}: ${i.name}`).join("\n") || "(none yet)"}\n\nPHOTO TO ANALYZE:`,
                },
                { type: "image", image: bytes },
              ],
            },
          ],
        });

        const itemById = new Map(allItems.map((it) => [it.id, it]));
        let created = 0;
        let matched = 0;
        for (const obj of object.objects.slice(0, 30)) {
          let itemId: number | null = obj.matchedItemId != null && itemById.has(obj.matchedItemId) ? obj.matchedItemId : null;
          if (itemId) {
            matched++;
          } else {
            let best = 0;
            for (const it of allItems) {
              const s = nameScore(obj.label, it.name);
              if (s > best) {
                best = s;
                itemId = it.id;
              }
            }
            if (best < 0.5) itemId = null;
            else matched++;
          }
          await db.insert(photoAnnotations).values({
            attachmentId: input.attachmentId,
            xPct: obj.xPct,
            yPct: obj.yPct,
            wPct: obj.wPct ?? null,
            hPct: obj.hPct ?? null,
            label: obj.label,
            itemId,
            origin: "ai",
            status: "suggested",
          });
          created++;
        }
        await logEvent({
          entityType: "annotation",
          entityId: input.attachmentId,
          action: "pins-detected",
          summary: `AI detected ${created} object(s) in photo #${input.attachmentId} (${matched} matched to inventory)`,
          actor: "ai",
          payload: { created, matched },
        });
        return { ok: true as const, created, matched };
      } catch (err) {
        const classified = classifyAiError(err);
        return { ok: false as const, error: classified.message };
      }
    }),

  /** AI: label a single hand-drawn box (the "New pin" AI-suggest button) */
  suggestForBox: publicQuery
    .input(
      z.object({
        attachmentId: z.number(),
        xPct: z.number().min(0).max(100),
        yPct: z.number().min(0).max(100),
        wPct: z.number().min(0).max(100),
        hPct: z.number().min(0).max(100),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const att = await db.query.attachments.findFirst({
        where: eq(attachments.id, input.attachmentId),
      });
      if (!att?.storageKey) {
        return { ok: false as const, error: "No stored image for this attachment." };
      }

      try {
        const bytes = await readFileBytes(att.storageKey);
        const cropped = await cropPercent(bytes, input);
        const allItems = await db
          .select()
          .from(items)
          .where(eq(items.status, "active"))
          .orderBy(desc(items.updatedAt));
        const refContent = await buildReferenceContent(db, allItems, 10);

        const model = await getVisionModel();
        const { object } = await generateObject({
          model,
          schema: suggestSchema,
          messages: [
            {
              role: "user",
              content: [
                ...refContent,
                {
                  type: "text",
                  text: `Name the single object in the PHOTO BELOW (a hand-picked crop, already framed on it — describe what's in it, not the background around it).\n\n${refContent.length ? "Some existing items' reference photos were shown above this message. If this is the SAME PHYSICAL OBJECT as one of those, set matchedItemId to its id — only if you actually recognize it visually, not from the name alone.\n\n" : ""}The user's full existing inventory (for name-based context only, not all of these have a reference photo):\n${allItems.slice(0, 200).map((i) => `- ${i.id}: ${i.name}`).join("\n") || "(none yet)"}\n\nPHOTO TO ANALYZE:`,
                },
                { type: "image", image: cropped },
              ],
            },
          ],
        });

        const itemById = new Map(allItems.map((it) => [it.id, it]));
        let itemId: number | null =
          object.matchedItemId != null && itemById.has(object.matchedItemId) ? object.matchedItemId : null;
        if (!itemId) {
          let best = 0;
          for (const it of allItems) {
            const s = nameScore(object.label, it.name);
            if (s > best) {
              best = s;
              itemId = it.id;
            }
          }
          if (best < 0.5) itemId = null;
        }
        return { ok: true as const, label: object.label, itemId, itemName: itemId ? (itemById.get(itemId)?.name ?? null) : null };
      } catch (err) {
        const classified = classifyAiError(err);
        return { ok: false as const, error: classified.message };
      }
    }),
});
