import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, areas, items, attachments, type TriageSuggestion } from "@db/schema";
import { logEvent } from "../lib/events";
import { getModel, getSecondModel } from "../lib/ai";
import { classifyAiError, AiMisconfigured } from "../lib/ai-client";
import { putFile, readFileBytes } from "../lib/filestore";

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
      return { ok: false as const, error: classified.message, retryable: classified instanceof AiMisconfigured === false };
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
      return { label, suggestion: null, error: classified.message, ms: 0 };
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
          kind: cap.kind === "link" ? "link" : cap.storageKey ? cap.kind : "note",
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
