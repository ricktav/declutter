import { z } from "zod";
import { createHash } from "crypto";
import { eq, desc, isNull, and, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, areas, items, attachments, type TriageSuggestion } from "@db/schema";
import { logEvent } from "../lib/events";
import { getModel, getSecondModel, getVisionModel } from "../lib/ai";
import { claudeCliObject, isClaudeCliDevMode } from "../lib/claudeCli";
import { classifyAiError, AiMisconfigured } from "../lib/ai-client";
import { putFile, readFileBytes, deleteStoredFile } from "../lib/filestore";
import { cropPercent, toThumbnail } from "../lib/crop";
import { createCapture } from "../lib/captures";

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

const triageSchema = z.object({
  areaSlug: z.string().describe("slug of the best-matching area"),
  itemName: z.string().describe("short name for the item this capture is about"),
  matchedItemId: z.number().nullable().describe("id of an existing item this belongs to, or null if new"),
  isNewItem: z.boolean(),
  attributes: z.record(z.string(), z.string()).describe("extracted attribute key/values"),
  note: z.string().describe("one-line summary of what this capture is"),
  confidence: z.enum(["high", "medium", "low"]),
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

  let textPrompt = `You are triaging a capture into a home inventory system.\n\n${context}\n\nCAPTURE (kind: ${cap.kind}):\n${cap.rawText ?? ""}\n${cap.url ? `URL: ${cap.url}` : ""}\n\nDecide: which area does this belong to? Is it about an existing item (give its id) or a new item? Extract obvious attributes (e.g. for computers: cpu, ram, storage, os, role).`;

  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array }> = [
    { type: "text", text: textPrompt },
  ];
  if (cap.kind === "image" && cap.storageKey) {
    try {
      const bytes = await readFileBytes(cap.storageKey);
      parts.push({ type: "image", image: bytes });
    } catch {
      textPrompt += "\n(image bytes unavailable — triage from text only)";
      parts[0] = { type: "text", text: textPrompt };
    }
  }
  return parts;
}

function toSuggestion(object: z.infer<typeof triageSchema>): TriageSuggestion {
  return {
    areaSlug: object.areaSlug,
    itemName: object.itemName,
    matchedItemId: object.matchedItemId ?? undefined,
    isNewItem: object.isNewItem,
    attributes: object.attributes,
    note: object.note,
    confidence: object.confidence,
  };
}

async function runTriage(model: Awaited<ReturnType<typeof getModel>>, content: TriageContent) {
  const { object } = await generateObject({
    model,
    schema: triageSchema,
    messages: [{ role: "user", content }],
  });
  return toSuggestion(object);
}

const TRIAGE_JSON_SHAPE = `{
  "areaSlug": string,
  "itemName": string,
  "matchedItemId": number or null,
  "isNewItem": boolean,
  "attributes": { "key": "value", ... },
  "note": string,
  "confidence": "high" | "medium" | "low"
}`;

/** Dev-mode: same triage prompt, routed through `claude -p` instead of the
 * configured API provider - see claudeCli.ts for why/how. */
async function runTriageViaClaudeCli(content: TriageContent) {
  const textPrompt = content.find((p) => p.type === "text")?.text ?? "";
  const imagePart = content.find((p) => p.type === "image") as { type: "image"; image: Uint8Array } | undefined;
  const object = await claudeCliObject({
    textPrompt,
    imageBytes: imagePart?.image,
    schema: triageSchema,
    jsonShape: TRIAGE_JSON_SHAPE,
  });
  return toSuggestion(object);
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
  list: publicQuery.query(async () => {
    return getDb().select().from(captures).orderBy(desc(captures.createdAt)).limit(100);
  }),

  create: publicQuery
    .input(
      z.object({
        kind: z.enum(["note", "link", "image", "file", "scan", "voice"]),
        rawText: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        contentBase64: z.string().max(14_000_000).optional(),
        mimeType: z.string().optional(),
        exifGps: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const row = await createCapture({
        kind: input.kind,
        rawText: input.rawText,
        url: input.url,
        bytes: input.contentBase64 ? Uint8Array.from(Buffer.from(input.contentBase64, "base64")) : undefined,
        fileName: input.fileName ?? "capture",
        contentType: input.mimeType,
        exifGps: input.exifGps,
        source: "user",
      });
      return { id: row.id, storageKey: row.storageKey };
    }),

  /** Ask the LLM to propose where this capture belongs */
  triage: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap) throw new Error("capture not found");

    try {
      const content = await buildTriageContent(cap);
      const suggestion = isClaudeCliDevMode()
        ? await runTriageViaClaudeCli(content)
        : await runTriage(await getModel(), content);

      await db.update(captures).set({ suggestion }).where(eq(captures.id, input.id));
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "triaged",
        summary: `AI triage${isClaudeCliDevMode() ? " (claude -p dev mode)" : ""}: "${suggestion.itemName}" → ${suggestion.areaSlug} (${suggestion.confidence} confidence)`,
        actor: "ai",
        payload: suggestion as Record<string, unknown>,
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
  compare: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
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
      runTriage(aModel, content),
      runTriage(second.model, content),
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
  detectObjects: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap?.storageKey) {
      return { ok: false as const, error: "This capture has no stored image." };
    }
    try {
      const bytes = await readFileBytes(cap.storageKey);
      const allItems = await db
        .select()
        .from(items)
        .where(eq(items.status, "active"))
        .orderBy(desc(items.updatedAt));

      // reference photos let the model recognize a re-photographed item by
      // sight instead of guessing from name text alone (which misses
      // whenever it phrases the label differently the second time round)
      const photoRows = await db
        .select({ itemId: attachments.itemId, storageKey: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.kind, "image"));
      const photoByItem = new Map<number, string>();
      for (const p of photoRows) {
        if (p.itemId && p.storageKey && !photoByItem.has(p.itemId)) photoByItem.set(p.itemId, p.storageKey);
      }
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

  /** File one detected object: create/link item + cutout attachment cropped from the original snap */
  fileObject: publicQuery
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
        houseId: z.number().nullable().optional(),
        floor: z.string().optional(),
        room: z.string().optional(),
        markProcessed: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
      if (!cap?.storageKey) throw new Error("capture has no stored image");

      let itemId = input.itemId;
      if (!itemId) {
        const [{ id: newId }] = await db
          .insert(items)
          .values({
            areaId: input.areaId,
            name: input.itemName,
            description: `Detected in snap: ${cap.rawText ?? "photo"}`,
            houseId: input.houseId ?? null,
            floor: input.floor ?? null,
            room: input.room ?? null,
          })
          .$returningId();
        itemId = newId;
        await logEvent({
          entityType: "item",
          entityId: itemId,
          action: "created",
          summary: `Item "${input.itemName}" created from detected object`,
          actor: "ai",
        });
      }

      // cutout: crop the box from the ORIGINAL snap and store as an attachment
      const bytes = await readFileBytes(cap.storageKey);
      const cropped = await cropPercent(bytes, {
        xPct: input.xPct,
        yPct: input.yPct,
        wPct: input.wPct,
        hPct: input.hPct,
      });
      const saved = await putFile({
        bytes: new Uint8Array(cropped),
        fileName: `items/${itemId}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      const item = await db.query.items.findFirst({ where: eq(items.id, itemId) });
      await db.insert(attachments).values({
        itemId,
        areaId: item?.areaId ?? input.areaId,
        kind: "image",
        title: `Cutout: ${input.label}`,
        storageKey: saved.key,
        mimeType: "image/jpeg",
        size: saved.size,
        sourceCaptureId: cap.id,
        cropBox: { xPct: input.xPct, yPct: input.yPct, wPct: input.wPct, hPct: input.hPct },
      });
      await logEvent({
        entityType: "item",
        entityId: itemId,
        action: "cutout-added",
        summary: `Cutout "${input.label}" added to item #${itemId} from capture #${input.id}`,
        actor: "ai",
        payload: { box: { xPct: input.xPct, yPct: input.yPct, wPct: input.wPct, hPct: input.hPct } },
      });
      if (input.markProcessed) {
        await db.update(captures).set({ status: "processed" }).where(eq(captures.id, input.id));
      }
      return { ok: true as const, itemId };
    }),

  accept: publicQuery
    .input(
      z.object({
        id: z.number(),
        areaId: z.number(),
        itemId: z.number().nullable(),
        itemName: z.string().min(1),
        attributes: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
      if (!cap) throw new Error("capture not found");

      let itemId = input.itemId;
      if (!itemId) {
        const [{ id: newId }] = await db
          .insert(items)
          .values({
            areaId: input.areaId,
            name: input.itemName,
            description: cap.rawText?.slice(0, 500) ?? null,
            attributes: input.attributes ?? null,
          })
          .$returningId();
        itemId = newId;
        await logEvent({
          entityType: "item",
          entityId: itemId,
          action: "created",
          summary: `Item "${input.itemName}" created from inbox capture`,
        });
      } else if (input.attributes && Object.keys(input.attributes).length) {
        const existing = await db.query.items.findFirst({ where: eq(items.id, itemId) });
        const merged = { ...(existing?.attributes ?? {}), ...input.attributes };
        await db.update(items).set({ attributes: merged }).where(eq(items.id, itemId));
      }

      // carry the capture content over as an attachment on the item
      if (cap.rawText || cap.url || cap.storageKey) {
        await db.insert(attachments).values({
          itemId,
          areaId: input.areaId,
          // scan/voice captures don't have a generic attachment-kind equivalent yet
          // (scan routes through the geometry normalizer instead) — fall back to file/note
          kind:
            cap.kind === "link"
              ? "link"
              : cap.kind === "image" || cap.kind === "file"
                ? cap.kind
                : cap.storageKey
                  ? "file"
                  : "note",
          title: cap.url ?? input.itemName,
          content: cap.rawText ?? null,
          url: cap.url ?? null,
          storageKey: cap.storageKey,
        });
      }
      await db.update(captures).set({ status: "triaged" }).where(eq(captures.id, input.id));
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "accepted",
        summary: `Capture accepted → item "${input.itemName}" (#${itemId})`,
      });
      return { ok: true, itemId };
    }),

  dismiss: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
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
   * any duplicate that's already been turned into an attachment (pinned),
   * since deleting that capture would break the pin. */
  mergeDuplicates: publicQuery.mutation(async () => {
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
      (
        await db
          .select({ sourceCaptureId: attachments.sourceCaptureId })
          .from(attachments)
          .where(inArray(attachments.sourceCaptureId, allDupeIds))
      )
        .map((a) => a.sourceCaptureId)
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
          // attachment still points to - but it's still a duplicate, so hide
          // it from Processed the same way dismissing anything else does
          if (c.status !== "dismissed") {
            await db.update(captures).set({ status: "dismissed" }).where(eq(captures.id, c.id));
          }
          skipped++;
          continue;
        }
        if (c.storageKey) await deleteStoredFile(c.storageKey).catch(() => {});
        await db.delete(captures).where(eq(captures.id, c.id));
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
