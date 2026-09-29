import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, areas, items, attachments, type TriageSuggestion } from "@db/schema";
import { logEvent } from "../lib/events";
import { getModel, getSecondModel, getVisionModel } from "../lib/ai";
import { classifyAiError, AiMisconfigured } from "../lib/ai-client";
import { putFile, readFileBytes } from "../lib/filestore";
import { cropPercent } from "../lib/crop";

const detectObjectsSchema = z.object({
  objects: z.array(
    z.object({
      label: z.string().describe("short specific name of the detected object"),
      xPct: z.number().min(0).max(100).describe("horizontal center, 0-100% of image width"),
      yPct: z.number().min(0).max(100).describe("vertical center, 0-100% of image height"),
      wPct: z.number().min(1).max(100).describe("width of the bounding box, 0-100% of image width"),
      hPct: z.number().min(1).max(100).describe("height of the bounding box, 0-100% of image height"),
    }),
  ),
});

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
        kind: z.enum(["note", "link", "image", "file"]),
        rawText: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        contentBase64: z.string().max(14_000_000).optional(),
        mimeType: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      let storageKey: string | null = null;
      if ((input.kind === "image" || input.kind === "file") && input.contentBase64) {
        const bytes = Uint8Array.from(Buffer.from(input.contentBase64, "base64"));
        const saved = await putFile({
          bytes,
          fileName: `inbox/${input.fileName ?? "capture"}`,
          contentType: input.mimeType,
        });
        storageKey = saved.key;
      }
      const [{ id }] = await db
        .insert(captures)
        .values({
          kind: input.kind,
          rawText: input.rawText ?? null,
          url: input.url ?? null,
          storageKey,
        })
        .$returningId();
      await logEvent({
        entityType: "capture",
        entityId: id,
        action: "created",
        summary: `Inbox capture (${input.kind}) added`,
      });
      return { id, storageKey };
    }),

  /** Ask the LLM to propose where this capture belongs */
  triage: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.id) });
    if (!cap) throw new Error("capture not found");

    try {
      const model = await getModel();
      const content = await buildTriageContent(cap);
      const suggestion = await runTriage(model, content);

      await db.update(captures).set({ suggestion }).where(eq(captures.id, input.id));
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "triaged",
        summary: `AI triage: "${suggestion.itemName}" → ${suggestion.areaSlug} (${suggestion.confidence} confidence)`,
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
      const allItems = await db.select().from(items).where(eq(items.status, "active"));
      const model = await getVisionModel();
      const { object } = await generateObject({
        model,
        schema: detectObjectsSchema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Identify the distinct physical objects worth inventorying in this photo (devices, tools, containers, appliances — NOT wall, floor, ceiling or background). List up to 12 of the most significant objects, fewer if that's all there is. For each object give a tight bounding box around the object itself: xPct/yPct is the box CENTER as a percentage of image width/height; wPct/hPct is the box width/height as a percentage of image width/height. Give each object a short, SPECIFIC name (brand + model if visible, e.g. "Mac mini M4", "Dell U2720Q monitor" — not just "computer").\n\nThe user's existing inventory items (your label will be matched against these names):\n${allItems.slice(0, 200).map((i) => `- ${i.id}: ${i.name}`).join("\n") || "(none yet)"}`,
              },
              { type: "image", image: bytes },
            ],
          },
        ],
      });
      const suggestions = object.objects.slice(0, 15).map((o) => {
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
        summary: `AI detected ${suggestions.length} object(s) in inbox capture #${input.id}`,
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
});
