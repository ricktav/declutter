import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createHash } from "crypto";
import { eq, desc, isNull, and, inArray, sql } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, areas, items, itemLinks, photos, rooms, type TriageSuggestion, type CropBox, type RoomGeometry } from "@db/schema";
import { parseGeojsonFloor } from "../lib/geojsonFloor";
import { type ScanPoly } from "../lib/scanMerge";
import { mergeScanObjects, scanMeta, localDate } from "../lib/scanObjects";
import { recordRoomScan, snapshotRoom } from "../lib/roomScans";
import { logEvent } from "../lib/events";
import { getModel, getSecondModel, getVisionModel } from "../lib/ai";
import { claudeCliObject, isClaudeCliDevMode } from "../lib/claudeCli";
import { classifyAiError, AiMisconfigured } from "../lib/ai-client";
import { readFileBytes, copyStoredFile, deleteStoredFile, putFile, withNewFile } from "../lib/filestore";
import { releaseStoredFiles } from "../lib/entities";
import { cropPercent, toThumbnail, normalizeOrientation } from "../lib/crop";
import { createCapture } from "../lib/captures";
import { setItemLocation } from "../lib/location";
import { coverPhotos, ensureLocationPhotoForCapture, ensureLocationPhotoInTx, ensurePinForCutout } from "../lib/photos";

const detectObjectsSchema = z.object({
  objects: z.array(
    z.object({
      label: z.string().describe("short specific name of the detected object"),
      xPct: z.number().min(0).max(100).describe("horizontal center, 0-100% of image width"),
      yPct: z.number().min(0).max(100).describe("vertical center, 0-100% of image height"),
      wPct: z.number().min(1).max(100).describe("width of the bounding box, 0-100% of image width"),
      hPct: z.number().min(1).max(100).describe("height of the bounding box, 0-100% of image height"),
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

/** crude name-similarity, same approach as the items router */
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

/** A frame on the photo in percent of the image (centre + size), the
 * CropBox / pins.detect convention: inside 0-100 and never zero-sized. */
export const cropBoxSchema = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  wPct: z.number().positive().max(100),
  hPct: z.number().positive().max(100),
});

/** a spotted object's box as the model gave it, or null when it gave none or
 * an invalid one: one bad box costs that frame, never the whole triage */
export function cleanBox(v: unknown): CropBox | null {
  const r = cropBoxSchema.safeParse(v);
  return r.success ? r.data : null;
}

// The model-facing box: plain numbers (strict structured outputs keep every
// key required; bounds are in the descriptions), missing or invalid -> null.
const triageBoxSchema = z.preprocess(
  (v) => cleanBox(v),
  z
    .object({
      xPct: z.number().describe("box CENTER, 0-100% of image width"),
      yPct: z.number().describe("box CENTER, 0-100% of image height"),
      wPct: z.number().describe("box width, 0-100% of image width"),
      hPct: z.number().describe("box height, 0-100% of image height"),
    })
    .nullable()
    .describe("tight bounding box around the object itself in the photo, or null when there is no photo or the object is not visible in it"),
);

const triageItemSchema = z.object({
  itemName: z.string().describe("short, specific name for this spotted object"),
  areaSlug: z.string().describe("slug of the best-matching area/topic for this object"),
  matchedItemId: z.number().nullable().describe("id of an existing item this is, or null if it's not already in the inventory"),
  isNewItem: z.boolean(),
  attributes: z.record(z.string(), z.string()).describe("extracted attribute key/values, empty object if none obvious"),
  confidence: z.enum(["high", "medium", "low"]),
  box: triageBoxSchema,
});

const triageSchema = z.object({
  note: z.string().describe("one-line overview of the scene as a whole, not any single object"),
  floor: z.string().nullable().describe("floor this was likely taken on, if inferable from context (e.g. an existing matched item's known floor), otherwise null"),
  room: z.string().nullable().describe("room this was likely taken in, if inferable, otherwise null"),
  items: z
    .array(triageItemSchema)
    .describe("every distinct physical object worth inventorying that's visible - not just the most prominent one. A close-up of one thing still gets a one-item list; a cluttered scene should list everything significant."),
});

type CaptureRow = typeof captures.$inferSelect;

async function buildTriageContent(cap: CaptureRow): Promise<
  Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array }>
> {
  const db = getDb();
  const allAreas = await db.select().from(areas);
  const allItems = await db.select().from(items).where(eq(items.status, "active"));

  const context = [
    "AREAS (slug — name):",
    ...allAreas.map((a) => `- ${a.slug} — ${a.name}${a.description ? `: ${a.description}` : ""}`),
    "",
    "EXISTING ITEMS (id — name):",
    ...allItems.slice(0, 200).map((i) => `- ${i.id} — ${i.name}`),
  ].join("\n");

  let textPrompt = `You are triaging a capture into a home inventory system.\n\n${context}\n\nCAPTURE (kind: ${cap.kind}):\n${cap.rawText ?? ""}\n${cap.url ? `URL: ${cap.url}` : ""}\n\nList every distinct physical object worth inventorying that's visible - not just the single most prominent one. For each: which area/topic does it belong to? Is it an existing item (give its id) or new? Extract obvious attributes (e.g. for computers: cpu, ram, storage, os, role). When there is a photo, give each object a tight bounding box around the object itself: xPct/yPct is the box CENTER as a percentage of image width/height; wPct/hPct is the box width/height as a percentage of image width/height (box null when there is no photo). Also suggest the floor/room this was likely taken in if you can tell (e.g. from an existing matched item's known location, or visible context), otherwise leave them null - don't guess at a location with nothing to go on.`;

  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array }> = [
    { type: "text", text: textPrompt },
  ];
  if (cap.kind === "image" && cap.storageKey) {
    try {
      const bytes = await normalizeOrientation(await readFileBytes(cap.storageKey));
      parts.push({ type: "image", image: bytes });
    } catch {
      textPrompt += "\n(image bytes unavailable — triage from text only)";
      parts[0] = { type: "text", text: textPrompt };
    }
  }
  return parts;
}

/** Resolve matchedItemId -> matchedItemName and suggest a floor/room from any
 * matched item's own location when the model didn't already (everything in
 * one photo is almost certainly the same room, same logic as Detect
 * Objects uses for its location default). */
/** a triage answer as parsed; `box` may be missing (older answers) or invalid */
type RawTriage = Omit<z.infer<typeof triageSchema>, "items"> & {
  items: Array<Omit<z.infer<typeof triageItemSchema>, "box"> & { box?: unknown }>;
};

export async function resolveSuggestion(object: RawTriage, houseId: number | null): Promise<TriageSuggestion> {
  const db = getDb();
  const ids = [...new Set(object.items.map((i) => i.matchedItemId).filter((id): id is number => id != null))];
  const matched = ids.length ? await db.select().from(items).where(inArray(items.id, ids)) : [];
  const byId = new Map(matched.map((i) => [i.id, i]));

  const floor = object.floor;
  const room = object.room;
  let roomId: number | null = null;
  if (room && houseId != null) {
    const [hit] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.houseId, houseId), sql`lower(${rooms.name}) = ${room.trim().toLowerCase()}`))
      .limit(1);
    roomId = hit?.id ?? null;
  } else if (!room) {
    // only a matched item in the session house may supply a room: ids from
    // another house would not be in the picker's list
    const withRoom = houseId != null ? matched.find((i) => i.roomId != null && i.houseId === houseId) : undefined;
    roomId = withRoom?.roomId ?? null;
  }

  return {
    note: object.note,
    floor,
    room,
    roomId,
    items: object.items.map((it) => ({
      itemName: it.itemName,
      areaSlug: it.areaSlug,
      matchedItemId: it.matchedItemId,
      matchedItemName: it.matchedItemId != null ? (byId.get(it.matchedItemId)?.name ?? null) : null,
      isNewItem: it.isNewItem,
      attributes: it.attributes,
      confidence: it.confidence,
      box: cleanBox(it.box),
    })),
  };
}

async function runTriage(model: Awaited<ReturnType<typeof getModel>>, content: TriageContent, houseId: number | null) {
  const { object } = await generateObject({
    model,
    schema: triageSchema,
    messages: [{ role: "user", content }],
  });
  return resolveSuggestion(object, houseId);
}

const TRIAGE_JSON_SHAPE = `{
  "note": string,
  "floor": string or null,
  "room": string or null,
  "items": [
    { "itemName": string, "areaSlug": string, "matchedItemId": number or null, "isNewItem": boolean, "attributes": { "key": "value", ... }, "confidence": "high" | "medium" | "low", "box": { "xPct": number, "yPct": number, "wPct": number, "hPct": number } or null },
    ...
  ]
}`;

/** Dev-mode: same triage prompt, routed through `claude -p` instead of the
 * configured API provider - see claudeCli.ts for why/how. */
async function runTriageViaClaudeCli(content: TriageContent, houseId: number | null) {
  const textPrompt = content.find((p) => p.type === "text")?.text ?? "";
  const imagePart = content.find((p) => p.type === "image") as { type: "image"; image: Uint8Array } | undefined;
  const object = await claudeCliObject({
    textPrompt,
    imageBytes: imagePart?.image,
    schema: triageSchema,
    jsonShape: TRIAGE_JSON_SHAPE,
  });
  return resolveSuggestion(object, houseId);
}

type TriageContent = Awaited<ReturnType<typeof buildTriageContent>>;

/** pull the provider's own error message out of an AI SDK error (best effort) */
function providerErrorDetail(err: unknown): string | null {
  const anyErr = err as {
    responseBody?: unknown;
    response?: { body?: unknown };
    data?: unknown;
  };
  const raw = anyErr?.responseBody ?? anyErr?.response?.body ?? anyErr?.data;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const msg = parsed?.error?.message ?? parsed?.message ?? null;
    return typeof msg === "string" && msg ? msg : null;
  } catch {
    return null;
  }
}

export const inboxRouter = createRouter({
  list: procedure.query(async () => {
    return getDb().select().from(captures).orderBy(desc(captures.createdAt)).limit(100);
  }),

  create: procedure
    .input(
      z.object({
        kind: z.enum(["note", "link", "image", "file", "scan", "voice"]),
        rawText: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload */
        storageKey: z.string().startsWith("local/").optional(),
        mimeType: z.string().optional(),
        exifGps: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const row = await createCapture({
        kind: input.kind,
        rawText: input.rawText,
        url: input.url,
        storageKey: input.storageKey,
        fileName: input.fileName ?? "capture",
        contentType: input.mimeType,
        exifGps: input.exifGps,
        source: "user",
      });
      return { id: row.id, storageKey: row.storageKey };
    }),

  /** Ask the LLM to propose where this capture belongs */
  triage: procedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap) throw new Error("capture not found");

    try {
      const content = await buildTriageContent(cap);
      const suggestion = isClaudeCliDevMode()
        ? await runTriageViaClaudeCli(content, ctx.houseId)
        : await runTriage(await getModel(), content, ctx.houseId);

      await db.update(captures).set({ suggestion }).where(eq(captures.id, input.id));
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "triaged",
        summary: `AI triage${isClaudeCliDevMode() ? " (claude -p dev mode)" : ""}: spotted ${suggestion.items.length} item${suggestion.items.length === 1 ? "" : "s"} (${suggestion.items.filter((i) => i.isNewItem).length} new)`,
        actor: "ai",
        payload: suggestion as unknown as Record<string, unknown>,
      });
      return { ok: true as const, suggestion };
    } catch (err) {
      const classified = classifyAiError(err);
      const detail = providerErrorDetail(err);
      return {
        ok: false as const,
        error: detail ? `${classified.message} — ${detail}` : classified.message,
        retryable: classified instanceof AiMisconfigured === false,
      };
    }
  }),

  /** Run the same triage prompt on Provider A and Provider B, side by side */
  compare: procedure.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap) throw new Error("capture not found");

    let content: TriageContent;
    try {
      content = await buildTriageContent(cap);
    } catch (err) {
      return { ok: false as const, error: `Failed to build prompt: ${(err as Error).message}` };
    }

    const second = await getSecondModel();
    if (!second) {
      return {
        ok: false as const,
        error:
          "No Provider B configured. Add LLM2_* to .env " +
          "(e.g. LLM2_BASE_URL=https://openrouter.ai/api/v1) or set it on the Settings page.",
      };
    }

    const aModel = await getModel();
    const [aRes, bRes] = await Promise.allSettled([
      runTriage(aModel, content, ctx.houseId),
      runTriage(second.model, content, ctx.houseId),
    ]);

    const side = (
      res: PromiseSettledResult<TriageSuggestion>,
      label: string,
    ): { label: string; suggestion: TriageSuggestion | null; error: string | null; ms: number } => {
      if (res.status === "fulfilled") {
        return { label, suggestion: res.value, error: null, ms: 0 };
      }
      const classified = classifyAiError(res.reason);
      const detail = providerErrorDetail(res.reason);
      return {
        label,
        suggestion: null,
        error: detail ? `${classified.message} — ${detail}` : classified.message,
        ms: 0,
      };
    };

    const result = {
      ok: true as const,
      a: side(aRes, "Provider A"),
      b: side(bRes, "Provider B"),
    };
    await logEvent({
      entityType: "capture",
      entityId: input.id,
      action: "compared",
      summary: `A/B triage comparison on capture #${input.id}`,
      actor: "ai",
      payload: {
        aOk: !!result.a.suggestion,
        bOk: !!result.b.suggestion,
      } as Record<string, unknown>,
    });
    return result;
  }),

  /** Accept a suggestion (possibly edited) — creates/links the item */
  /** AI: detect objects in an inbox photo, match against inventory — suggestions only, nothing persisted */
  detectObjects: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap?.storageKey) {
      return { ok: false as const, error: "This capture has no stored image." };
    }
    try {
      // normalized: the model's xPct/yPct/wPct/hPct must be computed
      // against the same upright frame the browser displays, or every
      // returned box ends up offset/rotated relative to the real objects
      const bytes = await normalizeOrientation(await readFileBytes(cap.storageKey));
      const allItems = await db
        .select()
        .from(items)
        .where(eq(items.status, "active"))
        .orderBy(desc(items.updatedAt));

      // reference photos let the model recognize a re-photographed item by
      // sight instead of guessing from name text alone (which misses
      // whenever it phrases the label differently the second time round)
      const photoByItem = new Map([...(await coverPhotos(db))].map(([itemId, p]) => [itemId, p.storageKey] as const));
      const refItems = allItems.filter((it) => photoByItem.has(it.id)).slice(0, MAX_REFERENCE_PHOTOS);
      const refContent: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array }> = [];
      for (const it of refItems) {
        try {
          const refBytes = await toThumbnail(await readFileBytes(photoByItem.get(it.id)!));
          refContent.push({ type: "text", text: `Reference photo — existing item [id ${it.id}]: "${it.name}"` });
          refContent.push({ type: "image", image: refBytes });
        } catch {
          // file missing on disk — skip this one reference, not fatal
        }
      }

      const detectPrompt = `Identify the distinct physical objects worth inventorying in the PHOTO (devices, tools, containers, appliances — NOT wall, floor, ceiling or background). List up to 12 of the most significant objects, fewer if that's all there is. For each object give a tight bounding box around the object itself: xPct/yPct is the box CENTER as a percentage of image width/height; wPct/hPct is the box width/height as a percentage of image width/height. Give each object a short, SPECIFIC name (brand + model if visible, e.g. "Mac mini M4", "Dell U2720Q monitor" — not just "computer").\n\nThe user's full existing inventory, for name-based matching only - set matchedItemId when an object is clearly the same item by name, otherwise null:\n${allItems.slice(0, 200).map((i) => `- ${i.id}: ${i.name}`).join("\n") || "(none yet)"}`;

      const object = isClaudeCliDevMode()
        ? await claudeCliObject({
            // dev mode keeps it to the main photo only (no reference photos -
            // the CLI helper takes a single image), so visual re-matching
            // against existing item photos doesn't apply here, name-based
            // matching still does
            textPrompt: detectPrompt,
            imageBytes: bytes,
            schema: detectObjectsSchema,
            jsonShape: `{ "objects": [ { "label": string, "xPct": number, "yPct": number, "wPct": number, "hPct": number, "matchedItemId": number or null }, ... ] }`,
          })
        : (
            await generateObject({
              model: await getVisionModel(),
              schema: detectObjectsSchema,
              messages: [
                {
                  role: "user",
                  content: [
                    ...refContent,
                    {
                      type: "text",
                      text: `${detectPrompt}${refContent.length ? "\n\nSome existing items' reference photos were shown above this message. If an object in the photo below is the SAME PHYSICAL OBJECT as one of those reference photos, set matchedItemId to its id — a name-only guess is not enough, only match if you actually recognize it visually." : ""}\n\nPHOTO TO ANALYZE:`,
                    },
                    { type: "image", image: bytes },
                  ],
                },
              ],
            })
          ).object;
      const itemById = new Map(allItems.map((it) => [it.id, it]));
      const suggestions = object.objects.slice(0, 15).map((o) => {
        // trust the model's own visual match (it saw the reference photo) over
        // text similarity; fall back to name-overlap only when it found nothing
        const visualMatch = o.matchedItemId != null ? itemById.get(o.matchedItemId) : undefined;
        if (visualMatch) {
          return { ...o, matchedItemId: visualMatch.id, matchedItemName: visualMatch.name, matchScore: 95 };
        }
        let matchedItemId: number | null = null;
        let matchedItemName: string | null = null;
        let best = 0;
        for (const it of allItems) {
          const s = nameScore(o.label, it.name);
          if (s > best) {
            best = s;
            matchedItemId = it.id;
            matchedItemName = it.name;
          }
        }
        if (best < 0.5) {
          matchedItemId = null;
          matchedItemName = null;
        }
        return { ...o, matchedItemId, matchedItemName, matchScore: Math.round(best * 100) };
      });
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "objects-detected",
        summary: `AI detected${isClaudeCliDevMode() ? " (claude -p dev mode)" : ""} ${suggestions.length} object(s) in inbox capture #${input.id}`,
        actor: "ai",
        payload: { count: suggestions.length },
      });
      return { ok: true as const, suggestions };
    } catch (err) {
      const classified = classifyAiError(err);
      const raw = (err as { responseBody?: string })?.responseBody;
      let detail: string | null = null;
      try {
        detail = raw ? (JSON.parse(raw).error?.message ?? null) : null;
      } catch { detail = null; }
      return { ok: false as const, error: detail ? `${classified.message} — ${detail}` : classified.message };
    }
  }),

  /** File one detected object: create/link item + a cutout photo cropped from the original snap */
  fileObject: procedure
    .input(
      z.object({
        id: z.number(), // capture id
        label: z.string().min(1),
        xPct: z.number().min(0).max(100),
        yPct: z.number().min(0).max(100),
        wPct: z.number().min(1).max(100),
        hPct: z.number().min(1).max(100),
        itemId: z.number().nullable(), // null = create new
        itemName: z.string().min(1), // used when creating
        areaId: z.number(), // used when creating
        roomId: z.number().nullable().optional(),
        houseId: z.number().nullable().optional(),
        markProcessed: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
      if (!cap?.storageKey) throw new Error("capture has no stored image");

      let itemId = input.itemId;
      if (!itemId) {
        itemId = await db.transaction(async (tx) => {
          const [{ id: newId }] = await tx
            .insert(items)
            .values({
              areaId: input.areaId,
              name: input.itemName,
              description: `Detected in snap: ${cap.rawText ?? "photo"}`,
              houseId: input.houseId ?? ctx.houseId ?? null,
            })
            .$returningId();
          if (input.roomId != null) await setItemLocation(tx, newId, { roomId: input.roomId });
          await logEvent(
            {
              entityType: "item",
              entityId: newId,
              action: "created",
              summary: `Item "${input.itemName}" created from detected object`,
              payload: { captureId: cap.id, origin: "ai-detect" },
            },
            tx,
          );
          return newId;
        });
      }

      // cutout: crop the box from the ORIGINAL snap and store it as a photo
      const bytes = await readFileBytes(cap.storageKey);
      const cropped = await cropPercent(bytes, {
        xPct: input.xPct,
        yPct: input.yPct,
        wPct: input.wPct,
        hPct: input.hPct,
      });
      const targetId: number = itemId;
      const item = await db.query.items.findFirst({ where: eq(items.id, targetId) });
      const box = { xPct: input.xPct, yPct: input.yPct, wPct: input.wPct, hPct: input.hPct };
      // the item is in the capture: pin it on the capture's location photo
      // (made now when the snap has none yet), so "Seen in photos" shows it
      const { photoId: locationPhotoId } = await ensureLocationPhotoForCapture(db, cap.id, input.roomId);
      await withNewFile(
        { bytes: new Uint8Array(cropped), fileName: `items/${targetId}/cutout-${Date.now()}.jpg`, contentType: "image/jpeg" },
        (saved) =>
          db.transaction(async (tx) => {
            await tx.insert(photos).values({
              itemId: targetId,
              areaId: item?.areaId ?? input.areaId,
              title: `Cutout: ${input.label}`,
              storageKey: saved.key,
              mimeType: "image/jpeg",
              size: saved.size,
              sourceCaptureId: cap.id,
              cropBox: box,
            });
            await logEvent(
              {
                entityType: "item",
                entityId: targetId,
                action: "cutout-added",
                summary: `Cutout "${input.label}" added to item #${targetId} from capture #${input.id}`,
                actor: "ai",
                payload: { box },
              },
              tx,
            );
            await ensurePinForCutout(tx, { sourcePhotoId: locationPhotoId, itemId: targetId, box, label: item?.name ?? input.itemName });
          }),
      );
      if (input.markProcessed) {
        await db.update(captures).set({ status: "processed" }).where(eq(captures.id, input.id));
      }
      return { ok: true as const, itemId };
    }),

  /** File several spotted items from one triage pass in a single pass - a
   * new item for each one not already matched, sharing one location (it's
   * all the same photo, almost certainly the same room). An existing match
   * is just acknowledged, not re-photographed - the whole-scene photo isn't
   * a useful addition to an item that's already catalogued. An item with a
   * triage `box` (image captures only) is pinned on the capture's location
   * photo, and a new one gets the crop instead of the whole scene. */
  acceptMany: procedure
    .input(
      z.object({
        id: z.number(),
        roomId: z.number().nullable().optional(),
        houseId: z.number().nullable().optional(),
        items: z
          .array(
            z.object({
              areaId: z.number(),
              itemId: z.number().nullable(),
              itemName: z.string().min(1),
              attributes: z.record(z.string(), z.string()).optional(),
              /** the triage frame of this object: pins it on the capture's
               * photo, and a new Thing gets the crop as its photo */
              box: cropBoxSchema.nullable().optional(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // file copies made inside the transaction: deleted again if it rolls back
      const copies: string[] = [];
      try {
        return await db.transaction(async (tx) => {
          const cap = await tx.query.captures.findFirst({ where: eq(captures.id, input.id) });
          if (!cap) throw new Error("capture not found");

          let created = 0;
          // boxes only mean something on an image capture's own photo
          const framed = cap.kind === "image" && cap.storageKey != null;
          let locationPhotoId: number | null = null;
          const locationPhoto = async () =>
            (locationPhotoId ??= (await ensureLocationPhotoInTx(tx, cap.id, input.roomId, copies)).photoId);
          let capBytes: Uint8Array | null = null;
          for (const it of input.items) {
            let itemId = it.itemId;
            if (!itemId) {
              const [{ id: newId }] = await tx
                .insert(items)
                .values({
                  areaId: it.areaId,
                  name: it.itemName,
                  description: cap.rawText?.slice(0, 500) ?? null,
                  attributes: it.attributes ?? null,
                  houseId: input.houseId ?? ctx.houseId ?? null,
                })
                .$returningId();
              itemId = newId;
              if (input.roomId != null) await setItemLocation(tx, itemId, { roomId: input.roomId });
              created++;
              await logEvent({
                entityType: "item",
                entityId: itemId,
                action: "created",
                summary: `Item "${it.itemName}" created from inbox capture`,
              }, tx);

              if (framed && it.box) {
                // the crop is the Thing's photo (like inbox.fileObject); the
                // whole scene stays reachable through the pin on the location photo
                capBytes ??= await readFileBytes(cap.storageKey!);
                const cropped = await cropPercent(capBytes, it.box);
                const saved = await putFile({
                  bytes: new Uint8Array(cropped),
                  fileName: `items/${itemId}/cutout-${Date.now()}.jpg`,
                  contentType: "image/jpeg",
                });
                copies.push(saved.key);
                await tx.insert(photos).values({
                  itemId,
                  areaId: it.areaId,
                  title: `Cutout: ${it.itemName}`,
                  storageKey: saved.key,
                  mimeType: "image/jpeg",
                  size: saved.size,
                  sourceCaptureId: cap.id,
                  cropBox: it.box,
                });
                await logEvent({
                  entityType: "item",
                  entityId: itemId,
                  action: "cutout-added",
                  summary: `Cutout "${it.itemName}" added to item #${itemId} from capture #${cap.id}`,
                  payload: { box: it.box },
                }, tx);
                await ensurePinForCutout(tx, { sourcePhotoId: await locationPhoto(), itemId, box: it.box, label: it.itemName });
              } else if (cap.rawText || cap.url || cap.storageKey) {
                // the item gets its own copy of the file: a capture and a
                // photo/link must never share one storage key (deleting one
                // would delete the other's bytes)
                const copy = cap.storageKey
                  ? await copyStoredFile(cap.storageKey, `items/${itemId}/${cap.storageKey.split("/").pop() ?? "photo"}`)
                  : null;
                if (copy) copies.push(copy.key);
                if (cap.kind === "image" && copy) {
                  await tx.insert(photos).values({
                    itemId,
                    areaId: it.areaId,
                    title: cap.url ?? it.itemName,
                    storageKey: copy.key,
                    size: copy.size,
                    sourceCaptureId: cap.id,
                  });
                } else {
                  await tx.insert(itemLinks).values({
                    itemId,
                    areaId: it.areaId,
                    kind: cap.kind === "link" ? "link" : copy ? "file" : "note",
                    title: cap.url ?? it.itemName,
                    content: cap.rawText ?? null,
                    url: cap.url ?? null,
                    storageKey: copy?.key ?? null,
                    size: copy?.size ?? null,
                    sourceCaptureId: cap.id,
                  });
                }
              }
            } else {
              if (it.attributes && Object.keys(it.attributes).length) {
                const existing = await tx.query.items.findFirst({ where: eq(items.id, itemId) });
                const merged = { ...(existing?.attributes ?? {}), ...it.attributes };
                await tx.update(items).set({ attributes: merged }).where(eq(items.id, itemId));
              }
              // an existing Thing is not re-photographed, but it is seen here
              if (framed && it.box) {
                const sourcePhotoId = await locationPhoto();
                await ensurePinForCutout(tx, {
                  sourcePhotoId,
                  itemId,
                  box: it.box,
                  label: it.itemName,
                  summary: `Pin "${it.itemName}" added to photo #${sourcePhotoId} for item #${itemId} from triage`,
                });
              }
            }
          }

          await tx.update(captures).set({ status: "triaged" }).where(eq(captures.id, input.id));
          await logEvent({
            entityType: "capture",
            entityId: input.id,
            action: "accepted",
            summary: `Capture accepted → ${input.items.length} item(s) filed (${created} new)`,
          }, tx);
          return { ok: true, created };
        });
      } catch (err) {
        for (const k of copies) await deleteStoredFile(k).catch(() => {});
        throw err;
      }
    }),

  /** Parse a pending .geojson capture's floor scan into a room (geometry +
   * detected furniture items) and mark the capture processed - the same
   * work scripts/import-geojson-floor.mjs did by hand, now reachable from
   * the Inbox itself so the capture doesn't sit pending forever. */
  importGeojson: procedure
    .input(
      z
        .object({
          captureId: z.number(),
          roomId: z.number().optional(),
          roomName: z.string().min(1).optional(),
          houseId: z.number().optional(),
        })
        .refine((v) => v.roomId != null || v.roomName != null, { message: "Pick a room or give a room name." }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null && input.roomId == null) throw new Error("Pick a house first.");
      const target = input.roomId != null
        ? await db.query.rooms.findFirst({ where: eq(rooms.id, input.roomId) })
        : null;
      if (input.roomId != null && !target) throw new Error("Room not found.");
      const targetHouseId = target?.houseId ?? houseId!;
      const match = target ?? (await db.query.rooms.findFirst({
        where: and(eq(rooms.houseId, targetHouseId), sql`lower(${rooms.name}) = ${input.roomName!.trim().toLowerCase()}`),
      }));
      const roomName = target?.name ?? input.roomName!.trim();
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.captureId) });
      if (!cap?.storageKey) throw new Error("Capture has no file to import.");
      // a capture is one timestamped scan; a new situation is a new capture
      if (cap.status === "processed") throw new TRPCError({ code: "BAD_REQUEST", message: "This capture was already imported." });

      let geojson: unknown;
      try {
        const bytes = await readFileBytes(cap.storageKey);
        geojson = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw new Error("Not valid JSON.");
      }
      const parsed = parseGeojsonFloor(geojson as { features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] });
      if (!parsed) throw new Error("No wall geometry found in this file.");
      const { walls, furniturePolys, widthM, depthM } = parsed;

      const polys: ScanPoly[] = furniturePolys.map((poly) => {
        const meta = scanMeta(poly.kind);
        const xs = poly.ring.map((p) => p[0]);
        const ys = poly.ring.map((p) => p[1]);
        return {
          kind: poly.kind,
          label: meta.label,
          xM: +Math.min(...xs).toFixed(2),
          yM: +Math.min(...ys).toFixed(2),
          wM: Math.max(0.1, +(Math.max(...xs) - Math.min(...xs)).toFixed(2)),
          dM: Math.max(0.1, +(Math.max(...ys) - Math.min(...ys)).toFixed(2)),
        };
      });

      // same houseId-then-name match as rooms.upsertFromScan, so re-running
      // an import for the same house+name updates in place
      const values = {
        houseId: targetHouseId,
        name: roomName,
        source: "mappedin" as const,
        scanDate: new Date(),
        widthM,
        depthM,
        walls,
        openings: [] as RoomGeometry["openings"],
      };
      const today = localDate(new Date());
      const counts = await db.transaction(async (tx) => {
        // the early check is for a fast error; this locked read stops two
        // concurrent imports of one capture from both getting through
        const [locked] = await tx.select({ status: captures.status }).from(captures).where(eq(captures.id, input.captureId)).for("update");
        if (locked?.status === "processed") throw new TRPCError({ code: "BAD_REQUEST", message: "This capture was already imported." });
        let roomId: number;
        // the room as it was, so this scan can be compared and undone (null: the scan creates it)
        const geometryBefore = match ? await snapshotRoom(tx, match.id) : null;
        if (match) {
          await tx.update(rooms).set(values).where(eq(rooms.id, match.id));
          roomId = match.id;
        } else {
          const [{ id }] = await tx.insert(rooms).values(values).$returningId();
          roomId = id;
        }

        const { changes, counts: merged } = await mergeScanObjects(tx, {
          roomId,
          houseId: targetHouseId,
          roomName,
          polys,
          detectedFrom: "floor scan (MappedIn export)",
          today,
        });
        const { moved, created } = merged;

        await recordRoomScan(tx, {
          roomId,
          houseId: targetHouseId,
          captureId: input.captureId,
          source: "geojson",
          scanDate: values.scanDate,
          before: geometryBefore,
          after: await snapshotRoom(tx, roomId),
          changes,
        });

        await tx.update(captures).set({ status: "processed" }).where(eq(captures.id, input.captureId));
        await logEvent(
          {
            entityType: "room",
            entityId: roomId,
            action: match ? "rescanned" : "created",
            summary: match
              ? `Room "${roomName}" rescanned: ${merged.matched} matched (${moved} moved), ${created} new, ${merged.missing} missing`
              : `Room "${roomName}" created from inbox geojson scan (${created} item(s) detected)`,
            actor: "system",
            payload: { captureId: input.captureId, matched: merged.matched, moved, created, missing: merged.missing },
          },
          tx,
        );
        return { roomId, created, matched: merged.matched, moved, missing: merged.missing };
      });
      return { ok: true, ...counts };
    }),

  dismiss: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().update(captures).set({ status: "dismissed" }).where(eq(captures.id, input.id));
    await logEvent({
      entityType: "capture",
      entityId: input.id,
      action: "dismissed",
      summary: `Capture #${input.id} dismissed`,
    });
    return { ok: true };
  }),

  /** Byte-identical captures sitting in the inbox (dev-phase feature: just
   * hard-deletes duplicates outright, keeping the oldest, rather than
   * leaving a "dismissed" row that would still clutter Processed).
   * Backfills a hash for any image capture that doesn't have one yet
   * (pre-dates content-hash dedup on create), then merges by hash. Skips
   * any duplicate that's already been turned into a photo or item link (pinned),
   * since deleting that capture would break the pin. */
  mergeDuplicates: procedure.mutation(async () => {
    const db = getDb();
    const unhashed = await db
      .select()
      .from(captures)
      .where(and(eq(captures.kind, "image"), isNull(captures.contentHash)));
    for (const c of unhashed) {
      if (!c.storageKey) continue;
      try {
        const bytes = await readFileBytes(c.storageKey);
        const hash = createHash("sha256").update(bytes).digest("hex");
        await db.update(captures).set({ contentHash: hash }).where(eq(captures.id, c.id));
      } catch {
        // file missing on disk - leave unhashed, not fatal
      }
    }

    const all = await db
      .select()
      .from(captures)
      .where(eq(captures.kind, "image"))
      .orderBy(desc(captures.createdAt));
    const byHash = new Map<string, typeof all>();
    for (const c of all) {
      if (!c.contentHash) continue;
      if (!byHash.has(c.contentHash)) byHash.set(c.contentHash, []);
      byHash.get(c.contentHash)!.push(c);
    }
    const dupeGroups = [...byHash.values()].filter((g) => g.length > 1);
    if (dupeGroups.length === 0) return { merged: 0, skipped: 0 };

    const allDupeIds = dupeGroups.flatMap((g) => g.map((c) => c.id));
    const pinned = new Set(
      [
        ...(await db.select({ c: photos.sourceCaptureId }).from(photos).where(inArray(photos.sourceCaptureId, allDupeIds))),
        ...(await db.select({ c: itemLinks.sourceCaptureId }).from(itemLinks).where(inArray(itemLinks.sourceCaptureId, allDupeIds))),
      ]
        .map((r) => r.c)
        .filter((id): id is number => id != null),
    );

    let merged = 0;
    let skipped = 0;
    for (const group of dupeGroups) {
      const sorted = [...group].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
      const [, ...rest] = sorted; // keep oldest
      for (const c of rest) {
        if (pinned.has(c.id)) {
          // can't delete the row - its storageKey may be the exact file an
          // photo or item link still points to - but it's still a duplicate, so hide
          // it from Processed the same way dismissing anything else does
          if (c.status !== "dismissed") {
            await db.update(captures).set({ status: "dismissed" }).where(eq(captures.id, c.id));
          }
          skipped++;
          continue;
        }
        await db.delete(captures).where(eq(captures.id, c.id));
        // only removes the bytes when no photo, item link or capture still points at them
        if (c.storageKey) await releaseStoredFiles(db, [c.storageKey]);
        merged++;
      }
    }
    if (merged > 0 || skipped > 0) {
      await logEvent({
        entityType: "capture",
        action: "merged",
        summary: `Merged ${merged} duplicate capture(s)${skipped ? `, dismissed ${skipped} more (already pinned elsewhere)` : ""}`,
      });
    }
    return { merged, skipped };
  }),
});
