import { z } from "zod";
import { eq, or, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { photoPins, photos, items, areas } from "@db/schema";
import { readFileBytes } from "../lib/filestore";
import { cropPercent, forDetectVision } from "../lib/crop";
import { getDetectVisionModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";
import { logEvent } from "../lib/events";
import { claudeCliObject, isClaudeCliDevMode } from "../lib/claudeCli";
import {
  MAX_REFERENCE_PHOTOS,
  DETECT_BOX_INSTRUCTIONS,
  buildReferenceContent,
  detectInventoryPrompt,
  houseIdForRoom,
  loadHouseInventory,
  matchDetectedItem,
  normalizeDetectBox,
  pickDetectHouseId,
} from "../lib/detectMatch";

const detectSchema = z.object({
  objects: z.array(
    z.object({
      label: z.string().describe("short name of the detected object"),
      xPct: z.number().min(0).max(100).describe("box CENTER x, 0-100% of image width — not top-left"),
      yPct: z.number().min(0).max(100).describe("box CENTER y, 0-100% of image height — not top-left"),
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

const suggestSchema = z.object({
  label: z.string().describe("short, specific name of the object in the cropped photo"),
});

export const pinsRouter = createRouter({
  listForPhoto: procedure
    .input(z.object({ photoId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const pins = await db
        .select()
        .from(photoPins)
        .where(eq(photoPins.photoId, input.photoId));
      const itemIds = [...new Set(pins.map((p) => p.itemId).filter((x): x is number => !!x))];
      const linked = itemIds.length
        ? await db.select().from(items).where(or(...itemIds.map((i) => eq(items.id, i))))
        : [];
      const nameMap = new Map(linked.map((i) => [i.id, i.name]));
      const descMap = new Map(linked.map((i) => [i.id, i.description ?? null]));
      // area color, not just name - the pin marker's fill reflects the
      // linked item's category, so a "black desk lamp" and a "Sonos
      // speaker" read differently on the photo at a glance
      const allAreas = await db.select().from(areas);
      const areaColorById = new Map(allAreas.map((a) => [a.id, a.color]));
      const areaColorByItem = new Map(linked.map((i) => [i.id, areaColorById.get(i.areaId) ?? null]));
      return pins
        .filter((p) => p.status !== "dismissed")
        .map((p) => ({
          ...p,
          itemName: p.itemId ? (nameMap.get(p.itemId) ?? null) : null,
          itemDescription: p.itemId ? (descMap.get(p.itemId) ?? null) : null,
          itemAreaColor: p.itemId ? (areaColorByItem.get(p.itemId) ?? null) : null,
        }));
    }),

  /** items pinned anywhere (back-references for the item page) */
  listForItem: procedure.input(z.object({ itemId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const pins = await db.select().from(photoPins).where(eq(photoPins.itemId, input.itemId));
    const photoIds = [...new Set(pins.map((p) => p.photoId))];
    const pics = photoIds.length ? await db.select().from(photos).where(inArray(photos.id, photoIds)) : [];
    const byId = new Map(pics.map((p) => [p.id, p]));
    return pins.filter((p) => p.status !== "dismissed").map((p) => ({ ...p, photo: byId.get(p.photoId) ?? null }));
  }),

  add: procedure
    .input(
      z.object({
        photoId: z.number(),
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
        .insert(photoPins)
        .values({
          photoId: input.photoId,
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
        entityType: "pin",
        entityId: id,
        action: "pin-added",
        summary: `Pin "${input.label || "untitled"}" added to photo #${input.photoId}`,
      });
      return { id };
    }),

  update: procedure
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
        status: z.enum(["suggested", "confirmed", "dismissed"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      await getDb().update(photoPins).set(patch).where(eq(photoPins.id, id));
      return { ok: true };
    }),

  resolve: procedure
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
        await db.update(photoPins).set(patch).where(eq(photoPins.id, input.id));
      } else {
        // hide the detection; do not delete a saved Thing, photo or file
        await db.update(photoPins).set({ status: "dismissed" }).where(eq(photoPins.id, input.id));
      }
      await logEvent({
        entityType: "pin",
        entityId: input.id,
        action: input.confirm ? "pin-confirmed" : "pin-dismissed",
        summary: `AI pin #${input.id} ${input.confirm ? "confirmed" : "dismissed"}`,
      });
      return { ok: true };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(photoPins).where(eq(photoPins.id, input.id));
    await logEvent({
      entityType: "pin",
      entityId: input.id,
      action: "pin-removed",
      summary: `Pin #${input.id} removed`,
    });
    return { ok: true };
  }),

  /** AI: detect objects in the photo, match against inventory, suggest pins */
  detect: procedure
    .input(z.object({ photoId: z.number(), houseId: z.number().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const att = await db.query.photos.findFirst({
        where: eq(photos.id, input.photoId),
      });
      if (!att?.storageKey) {
        return { ok: false as const, error: "No stored image for this photo." };
      }

      try {
        // upright + capped: same frame FramedRoomPhoto displays (browser EXIF)
        // so returned xPct/yPct/wPct/hPct overlay the real objects
        const bytes = await forDetectVision(await readFileBytes(att.storageKey));
        const photoHouseId = await houseIdForRoom(db, att.roomId);
        const houseId = pickDetectHouseId({ photoHouseId, explicitHouseId: input.houseId ?? null });
        const allItems = await loadHouseInventory(db, houseId);

        const refContent = await buildReferenceContent(db, allItems, MAX_REFERENCE_PHOTOS);

        const model = await getDetectVisionModel();
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
                  text: `Identify the distinct physical objects worth inventorying in the PHOTO BELOW (devices, tools, containers, appliances, furniture — NOT wall, floor, ceiling, windows, or other background). List up to 15 of the most significant objects. Do not pad the list with duplicates, parts of already-listed objects, or background — fewer accurate objects is better than many vague ones.\n\n${DETECT_BOX_INSTRUCTIONS}\n\n${refContent.length ? "Some existing items' reference photos were shown above this message. If an object in the photo below is the SAME PHYSICAL OBJECT as one of those reference photos, set matchedItemId to its id — only if you actually recognize it visually, not from the name alone.\n\n" : ""}${detectInventoryPrompt(allItems)}\n\nPHOTO TO ANALYZE:`,
                },
                { type: "image", image: bytes },
              ],
            },
          ],
        });

        let created = 0;
        let matched = 0;
        for (const obj of object.objects.slice(0, 30)) {
          const box = normalizeDetectBox(obj);
          if (!box) continue;
          const hit = matchDetectedItem(obj.label, obj.matchedItemId, allItems);
          if (hit.itemId) matched++;
          await db.insert(photoPins).values({
            photoId: input.photoId,
            xPct: box.xPct,
            yPct: box.yPct,
            wPct: box.wPct,
            hPct: box.hPct,
            label: obj.label,
            itemId: hit.itemId,
            origin: "ai",
            status: "suggested",
          });
          created++;
        }
        await logEvent({
          entityType: "pin",
          entityId: input.photoId,
          action: "pins-detected",
          summary: `AI detected ${created} object(s) in photo #${input.photoId} (${matched} matched to inventory)`,
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
  suggestForBox: procedure
    .input(
      z.object({
        photoId: z.number(),
        xPct: z.number().min(0).max(100),
        yPct: z.number().min(0).max(100),
        wPct: z.number().min(0).max(100),
        hPct: z.number().min(0).max(100),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const att = await db.query.photos.findFirst({
        where: eq(photos.id, input.photoId),
      });
      if (!att?.storageKey) {
        return { ok: false as const, error: "No stored image for this photo." };
      }

      try {
        const bytes = await readFileBytes(att.storageKey);
        const cropped = await cropPercent(bytes, input);

        // just the cutout, nothing else - this is purely "what is this
        // object", not an identity match against the inventory (that's
        // what typing into the item picker right below it is for), so no
        // reference photos or item list to confuse the answer
        const prompt =
          "Name the single object in this PHOTO (a hand-picked crop, already framed on it - describe what's in it, not the background around it). Be short and specific (brand + model if visible, e.g. \"Mac mini M4\", not just \"computer\").";

        const object = isClaudeCliDevMode()
          ? await claudeCliObject({
              textPrompt: prompt,
              imageBytes: cropped,
              schema: suggestSchema,
              jsonShape: `{ "label": string }`,
            })
          : (
              await generateObject({
                model: await getDetectVisionModel(),
                schema: suggestSchema,
                messages: [
                  { role: "user", content: [{ type: "text", text: prompt }, { type: "image", image: cropped }] },
                ],
              })
            ).object;

        return { ok: true as const, label: object.label };
      } catch (err) {
        const classified = classifyAiError(err);
        return { ok: false as const, error: classified.message };
      }
    }),
});
