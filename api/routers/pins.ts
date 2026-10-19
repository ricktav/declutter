import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { photoPins, photos } from "@db/schema";
import { coverPhotos } from "../lib/photos";
import { pinItemSummary, roomWithDescendants, withPinItems } from "../lib/pins";
import { photoScope, promptInventory } from "../lib/aiContext";
import { nameScore } from "../lib/text";
import { readFileBytes } from "../lib/filestore";
import { toThumbnail, cropPercent, normalizeOrientation } from "../lib/crop";
import { getDetectVisionModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";
import { logEvent } from "../lib/events";
import { claudeCliObject, isClaudeCliDevMode } from "../lib/claudeCli";

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
});

type RefContentPart = { type: "text"; text: string } | { type: "image"; image: Uint8Array };

/** Reference photos let the model recognize a re-photographed item by sight
 * instead of guessing from name text alone. */
async function buildReferenceContent(
  db: ReturnType<typeof getDb>,
  allItems: { id: number; name: string }[],
  limit: number,
): Promise<RefContentPart[]> {
  const photoByItem = new Map([...(await coverPhotos(db))].map(([itemId, p]) => [itemId, p.storageKey] as const));
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

export const pinsRouter = createRouter({
  /** A Photo's pins without the dismissed ones; `includeDismissed` adds them
   * (Annotate's "Place a Thing" restores a Thing's dismissed pin instead of
   * adding a second pin for it on the same Photo). */
  listForPhoto: procedure
    .input(z.object({ photoId: z.number(), includeDismissed: z.boolean().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const pins = await db.select().from(photoPins).where(eq(photoPins.photoId, input.photoId));
      return (await withPinItems(db, pins, { includeDismissed: input.includeDismissed })).map(({ pin, itemName, itemDescription, itemAreaColor }) => ({
        ...pin,
        itemName,
        itemDescription,
        itemAreaColor,
      }));
    }),

  /** Every pin on the Photos of a room and the rooms cut from it, each with
   * its Thing's role, Type, tags, decision and area: the room page's Schema
   * view in one call. Dismissed pins and pins of archived or rejected Things
   * are left out; item-less pins come with item: null. Not house-scoped: a
   * room belongs to one house. Ordered by photo, then pin. */
  listForRoom: procedure.input(z.object({ roomId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const roomIds = await roomWithDescendants(db, input.roomId);
    const pics = await db
      .select({ id: photos.id, title: photos.title, storageKey: photos.storageKey })
      .from(photos)
      .where(inArray(photos.roomId, roomIds));
    if (!pics.length) return [];
    const picById = new Map(pics.map((p) => [p.id, p]));
    const pins = await db
      .select()
      .from(photoPins)
      .where(inArray(photoPins.photoId, [...picById.keys()]))
      .orderBy(asc(photoPins.photoId), asc(photoPins.id));
    return (await withPinItems(db, pins))
      .filter(({ linked }) => !linked || (linked.status === "active" && linked.verificationStatus !== "rejected"))
      .map(({ pin, linked, itemName, itemAreaColor }) => {
        const pic = picById.get(pin.photoId)!;
        return {
          photoTitle: pic.title,
          photoStorageKey: pic.storageKey,
          ...pin,
          itemName,
          itemAreaColor,
          item: linked ? pinItemSummary(linked) : null,
        };
      });
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

  /** Adds a user pin. With `onePerThing` (Annotate's Place a Thing), a pin
   * of the same Thing on the same Photo, whatever its status, is moved there
   * instead: confirmed, its frame kept unless wPct/hPct are given, and
   * `{ id, existing: true }` returned, as ensurePinForCutout does. */
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
        onePerThing: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      return db.transaction(async (tx) => {
        if (input.onePerThing && input.itemId != null) {
          const mine = await tx
            .select()
            .from(photoPins)
            .where(and(eq(photoPins.photoId, input.photoId), eq(photoPins.itemId, input.itemId)))
            .orderBy(asc(photoPins.id))
            .for("update");
          const rank = { confirmed: 0, suggested: 1, dismissed: 2 } as const;
          const existing = [...mine].sort((a, b) => rank[a.status] - rank[b.status])[0];
          if (existing) {
            const patch: Partial<typeof photoPins.$inferInsert> = { xPct: input.xPct, yPct: input.yPct, status: "confirmed" };
            if (input.wPct !== undefined) patch.wPct = input.wPct;
            if (input.hPct !== undefined) patch.hPct = input.hPct;
            await tx.update(photoPins).set(patch).where(eq(photoPins.id, existing.id));
            return { id: existing.id, existing: true };
          }
        }
        const [{ id }] = await tx
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
        }, tx);
        return { id, existing: false };
      });
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
    .input(z.object({ photoId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const att = await db.query.photos.findFirst({
        where: eq(photos.id, input.photoId),
      });
      if (!att?.storageKey) {
        return { ok: false as const, error: "No stored image for this photo." };
      }

      try {
        // normalized: the model's xPct/yPct/wPct/hPct must be computed
        // against the same upright frame the browser displays, or every
        // returned box ends up offset/rotated relative to the real objects
        const bytes = await normalizeOrientation(await readFileBytes(att.storageKey));
        const allItems = await promptInventory(db, await photoScope(db, att, ctx.houseId));

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
                  text: `Identify the distinct physical objects worth inventorying in the PHOTO BELOW (devices, tools, containers, appliances, furniture — NOT wall, floor, ceiling, windows, or other background). List up to 15 of the most significant objects. Do not pad the list with duplicates, parts of already-listed objects, or background — fewer accurate objects is better than many vague ones.\n\nFor each object give a tight bounding box around the object itself: xPct/yPct is the box CENTER as a percentage of image width/height; wPct/hPct is the box width/height as a percentage of image width/height.\n\n${refContent.length ? "Some existing items' reference photos were shown above this message. If an object in the photo below is the SAME PHYSICAL OBJECT as one of those reference photos, set matchedItemId to its id — only if you actually recognize it visually, not from the name alone.\n\n" : ""}The user's existing inventory (for name-based context only, not all of these have a reference photo):\n${allItems.map((i) => `- ${i.id}: ${i.name}`).join("\n") || "(none yet)"}\n\nPHOTO TO ANALYZE:`,
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
          await db.insert(photoPins).values({
            photoId: input.photoId,
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
