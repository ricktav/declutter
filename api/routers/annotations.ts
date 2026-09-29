import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { generateObject } from "ai";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { photoAnnotations, attachments, items } from "@db/schema";
import { readFileBytes } from "../lib/filestore";
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
    }),
  ),
});

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
      return pins.map((p) => ({ ...p, itemName: p.itemId ? (nameMap.get(p.itemId) ?? null) : null }));
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
        const allItems = await db.select().from(items).where(eq(items.status, "active"));

        const model = await getVisionModel();
        const { object } = await generateObject({
          model,
          schema: detectSchema,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Identify every distinct physical object worth inventorying in this photo (devices, tools, containers, appliances, furniture — not wall/floor/background). For each, give its center position as a percentage of image width/height. Be precise with positions.\n\nThe user's existing inventory items (match labels to these names when they clearly refer to the same object):\n${allItems.slice(0, 200).map((i) => `- ${i.name}`).join("\n") || "(none yet)"}`,
                },
                { type: "image", image: bytes },
              ],
            },
          ],
        });

        let created = 0;
        let matched = 0;
        for (const obj of object.objects.slice(0, 30)) {
          let itemId: number | null = null;
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
          await db.insert(photoAnnotations).values({
            attachmentId: input.attachmentId,
            xPct: obj.xPct,
            yPct: obj.yPct,
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
});
