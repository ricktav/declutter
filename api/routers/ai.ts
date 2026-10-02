import { z } from "zod";
import { eq, asc, desc, and } from "drizzle-orm";
import { generateText } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items, attachments, chatMessages } from "@db/schema";
import { getModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";
import { logEvent } from "../lib/events";

async function buildContext(scope: "global" | "area" | "item", scopeId: number): Promise<string> {
  const db = getDb();
  if (scope === "item") {
    const item = await db.query.items.findFirst({ where: eq(items.id, scopeId) });
    if (!item) return "No item context.";
    const area = await db.query.areas.findFirst({ where: eq(areas.id, item.areaId) });
    const atts = await db.select().from(attachments).where(eq(attachments.itemId, item.id));
    return [
      `CURRENT ITEM: ${item.name} (area: ${area?.name ?? "?"})`,
      item.description ? `Description: ${item.description}` : "",
      item.attributes ? `Attributes: ${JSON.stringify(item.attributes)}` : "",
      atts.length
        ? `Attachments: ${atts.map((a) => `${a.kind}: ${a.title ?? a.url ?? ""}`).join("; ")}`
        : "",
      `Status: ${item.status}. Created: ${item.createdAt.toISOString().slice(0, 10)}.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (scope === "area") {
    const area = await db.query.areas.findFirst({ where: eq(areas.id, scopeId) });
    if (!area) return "No area context.";
    const areaItems = await db
      .select()
      .from(items)
      .where(eq(items.areaId, area.id));
    return [
      `CURRENT AREA: ${area.name}${area.description ? ` — ${area.description}` : ""}`,
      `Items (${areaItems.length}):`,
      ...areaItems.map(
        (i) =>
          `- ${i.name}${i.status === "archived" ? " (archived)" : ""}${i.attributes ? ` ${JSON.stringify(i.attributes)}` : ""}`,
      ),
    ].join("\n");
  }
  // global
  const allAreas = await db.select().from(areas);
  const allItems = await db.select().from(items);
  return [
    "INVENTORY OVERVIEW:",
    ...allAreas.map((a) => {
      const count = allItems.filter((i) => i.areaId === a.id && i.status === "active").length;
      return `- ${a.name} (${a.slug}): ${count} items`;
    }),
    "",
    "RECENT ITEMS:",
    ...allItems
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 30)
      .map((i) => `- ${i.name}${i.attributes ? ` ${JSON.stringify(i.attributes)}` : ""}`),
  ].join("\n");
}

export const aiRouter = createRouter({
  chat: procedure
    .input(
      z.object({
        scope: z.enum(["global", "area", "item"]).default("global"),
        scopeId: z.number().default(0),
        message: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      try {
        const context = await buildContext(input.scope, input.scopeId);
        const history = await db
          .select()
          .from(chatMessages)
          .where(and(eq(chatMessages.scope, input.scope), eq(chatMessages.scopeId, input.scopeId)))
          .orderBy(desc(chatMessages.createdAt))
          .limit(40);
        const scoped = history
          .reverse()
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        scoped.push({ role: "user", content: input.message });

        const model = await getModel();
        const { text } = await generateText({
          model,
          system: `You are the assistant inside "HomeBase", a personal home-inventory app. You help the user understand, organise and act on their inventory: computers and IT gear, garage, kitchen, and other areas. Be concise and practical. When relevant, suggest concrete tasks or note connections between items. Here is the current context:\n\n${context}`,
          messages: scoped,
        });

        // both turns land together, so a failed call leaves no orphan user row
        await db.insert(chatMessages).values([
          { scope: input.scope, scopeId: input.scopeId, role: "user", content: input.message },
          { scope: input.scope, scopeId: input.scopeId, role: "assistant", content: text },
        ]);
        return { ok: true as const, text };
      } catch (err) {
        const classified = classifyAiError(err);
        return { ok: false as const, error: classified.message };
      }
    }),

  history: procedure
    .input(
      z.object({
        scope: z.enum(["global", "area", "item"]).default("global"),
        scopeId: z.number().default(0),
      }),
    )
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.scope, input.scope), eq(chatMessages.scopeId, input.scopeId)))
        .orderBy(asc(chatMessages.createdAt))
        .limit(200);
      return rows;
    }),

  clearHistory: procedure
    .input(
      z.object({
        scope: z.enum(["global", "area", "item"]).default("global"),
        scopeId: z.number().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .delete(chatMessages)
        .where(and(eq(chatMessages.scope, input.scope), eq(chatMessages.scopeId, input.scopeId)));
      await logEvent({
        entityType: "chat",
        entityId: input.scopeId,
        action: "cleared",
        summary: `Chat history cleared (${input.scope})`,
      });
      return { ok: true };
    }),
});
