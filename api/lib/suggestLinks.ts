// api/lib/suggestLinks.ts
// Suggested relations for a Thing that was just created: name matches in its
// topic right away, semantic matches from the LLM after the response.
// items.create and photos.fileFrame (with suggestLinks: true) run this after
// their transaction has committed.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { generateObject } from "ai";
import { items, relations } from "@db/schema";
import type { getDb } from "../queries/connection";
import { logEvent } from "./events";
import { nameScore } from "./text";
import { getModel } from "./ai";

type Db = ReturnType<typeof getDb>;

export async function suggestLinksForNewItem(
  db: Db,
  input: { id: number; name: string; description?: string | null; areaId: number },
): Promise<{ suggestedRelations: number; suggestedLinks: { itemId: number; reason: string }[] }> {
  const { id, areaId } = input;
  // name-based suggestions run regardless; the LLM adds semantic matches
  // from the same area (it only sees same-area items, so links are scoped)
  const siblings = await db
    .select()
    .from(items)
    .where(and(eq(items.status, "active"), eq(items.areaId, areaId)));
  const suggestions: number[] = [];
  for (const s of siblings) {
    if (s.id === id) continue;
    if (nameScore(input.name, s.name) >= 0.5) {
      await db.insert(relations).values({
        fromItemId: id,
        toItemId: s.id,
        type: "related-to",
        origin: "ai",
        status: "suggested",
      });
      suggestions.push(s.id);
    }
  }
  if (suggestions.length) {
    await logEvent({
      entityType: "item",
      entityId: id,
      action: "links-suggested",
      summary: `Auto-suggested ${suggestions.length} possible relation(s) for "${input.name}"`,
      actor: "ai",
      payload: { suggestedItemIds: suggestions },
    });
  }

  // LLM: semantic suggested-links to existing items in this area. This runs after
  // the response: with the Claude CLI provider one call takes many seconds, and the
  // Workbench spun on every accepted pin waiting for it. The relations and the
  // "links-suggested" event land when the model answers; nothing reads them from
  // this response, so suggestedLinks is reported as empty here.
  const suggestedLinks: { itemId: number; reason: string }[] = [];
  void (async () => {
    // LLM: semantic suggested-links to existing items in this area
    const otherSiblings = siblings.filter((s) => s.id !== id);
    if (otherSiblings.length > 0) {
      try {
        const model = await getModel();
        const linksSchema = z.object({
          links: z.array(
            z.object({
              itemId: z.number().describe("id of the existing item to link to"),
              reason: z.string().describe("one short sentence: why they belong together"),
            }),
          ),
        });
        const { object } = await generateObject({
          model,
          schema: linksSchema,
          messages: [
            {
              role: "user",
              content: `A new item was just added to a home inventory.\n\nNEW ITEM (area: ${input.name}'s area, name: "${input.name}"${input.description ? `, description: "${input.description}"` : ""}).\n\nEXISTING ITEMS IN THE SAME AREA (id — name${input.description ? " — description" : ""}):\n${otherSiblings
                .slice(0, 100)
                .map((s) => `- ${s.id} — ${s.name}${s.description ? ` — ${s.description.slice(0, 120)}` : ""}`)
                .join("\n")}\n\nWhich of these existing items does the new item have a HIGH likelihood of being related to? Suggest only links you are fairly confident about (same setup, accessory of, part of, replacement for, used together, depends on). Return an empty list if nothing is clearly related. For each suggested link give a one-sentence reason.`,
            },
          ],
        });
        const valid = new Set(otherSiblings.map((s) => s.id));
        for (const l of object.links) {
          if (!valid.has(l.itemId) || suggestions.includes(l.itemId)) continue;
          await db.insert(relations).values({
            fromItemId: id,
            toItemId: l.itemId,
            type: "related-to",
            origin: "ai",
            status: "suggested",
          });
          suggestions.push(l.itemId);
          suggestedLinks.push({ itemId: l.itemId, reason: l.reason });
        }
        if (suggestedLinks.length) {
          await logEvent({
            entityType: "item",
            entityId: id,
            action: "links-suggested",
            summary: `LLM suggested ${suggestedLinks.length} semantic link(s) for "${input.name}"`,
            actor: "ai",
            payload: { links: suggestedLinks },
          });
        }
      } catch {
        // AI suggestions are best-effort — creation must never fail on them
      }
    }
  })();
  return { suggestedRelations: suggestions.length, suggestedLinks };
}
