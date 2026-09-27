import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, areas, items, attachments, type TriageSuggestion } from "@db/schema";
import { logEvent } from "../lib/events";
import { getModel } from "../lib/ai";
import { classifyAiError, AiMisconfigured } from "../lib/ai-client";
import { storage } from "../lib/storage";

const triageSchema = z.object({
  areaSlug: z.string().describe("slug of the best-matching area"),
  itemName: z.string().describe("short name for the item this capture is about"),
  matchedItemId: z.number().nullable().describe("id of an existing item this belongs to, or null if new"),
  isNewItem: z.boolean(),
  attributes: z.record(z.string(), z.string()).describe("extracted attribute key/values"),
  note: z.string().describe("one-line summary of what this capture is"),
  confidence: z.enum(["high", "medium", "low"]),
});

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
        try {
          const saved = await storage.uploadFile({
            fileContent: bytes,
            fileName: `inbox/${input.fileName ?? "capture"}`,
            contentType: input.mimeType,
          });
          storageKey = saved.key;
        } catch {
          // storage unprovisioned — keep capture without the file bytes
        }
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

    const allAreas = await db.select().from(areas);
    const allItems = await db.select().from(items).where(eq(items.status, "active"));

    const context = [
      "AREAS (slug — name):",
      ...allAreas.map((a) => `- ${a.slug} — ${a.name}${a.description ? `: ${a.description}` : ""}`),
      "",
      "EXISTING ITEMS (id — name):",
      ...allItems.slice(0, 200).map((i) => `- ${i.id} — ${i.name}`),
    ].join("\n");

    try {
      const model = await getModel();
      const contentParts: Array<
        { type: "text"; text: string } | { type: "image"; image: Uint8Array }
      > = [];
      let textPrompt = `You are triaging a capture into a home inventory system.\n\n${context}\n\nCAPTURE (kind: ${cap.kind}):\n${cap.rawText ?? ""}\n${cap.url ? `URL: ${cap.url}` : ""}\n\nDecide: which area does this belong to? Is it about an existing item (give its id) or a new item? Extract obvious attributes (e.g. for computers: cpu, ram, storage, os, role).`;
      contentParts.push({ type: "text", text: textPrompt });

      if (cap.kind === "image" && cap.storageKey) {
        try {
          const bytes = await storage.readFile({ fileKey: cap.storageKey });
          contentParts.push({ type: "image", image: bytes });
        } catch {
          textPrompt += "\n(image bytes unavailable — triage from text only)";
          contentParts[0] = { type: "text", text: textPrompt };
        }
      }

      const { object } = await generateObject({
        model,
        schema: triageSchema,
        messages: [{ role: "user", content: contentParts }],
      });

      const suggestion: TriageSuggestion = {
        areaSlug: object.areaSlug,
        itemName: object.itemName,
        matchedItemId: object.matchedItemId ?? undefined,
        isNewItem: object.isNewItem,
        attributes: object.attributes,
        note: object.note,
        confidence: object.confidence,
      };
      await db.update(captures).set({ suggestion }).where(eq(captures.id, input.id));
      await logEvent({
        entityType: "capture",
        entityId: input.id,
        action: "triaged",
        summary: `AI triage: "${object.itemName}" → ${object.areaSlug} (${object.confidence} confidence)`,
        actor: "ai",
        payload: suggestion as Record<string, unknown>,
      });
      return { ok: true as const, suggestion };
    } catch (err) {
      const classified = classifyAiError(err);
      return { ok: false as const, error: classified.message, retryable: classified instanceof AiMisconfigured === false };
    }
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
