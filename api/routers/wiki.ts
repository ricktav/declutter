import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { generateText } from "ai";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { areas, items, attachments, relations, wikiPages, type Area, type Item } from "@db/schema";
import { getModel } from "../lib/ai";
import { classifyAiError } from "../lib/ai-client";
import { logEvent } from "../lib/events";

function itemSlug(item: Item) {
  return `item-${item.id}`;
}

function renderItemPage(item: Item, area: Area | undefined, attTitles: string[], relLines: string[]) {
  const attrs = item.attributes ? Object.entries(item.attributes) : [];
  return [
    "---",
    `id: ${item.id}`,
    `type: item`,
    `area: ${area?.slug ?? "unknown"}`,
    `status: ${item.status}`,
    `updated: ${item.updatedAt.toISOString().slice(0, 10)}`,
    "---",
    "",
    `# ${item.name}`,
    "",
    item.description ?? "",
    attrs.length ? "## Attributes" : "",
    ...attrs.map(([k, v]) => `- **${k}**: ${v}`),
    attTitles.length ? "\n## Attachments" : "",
    ...attTitles.map((t) => `- ${t}`),
    relLines.length ? "\n## Related items" : "",
    ...relLines.map((r) => `- ${r}`),
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

async function buildPages() {
  const db = getDb();
  const allAreas = await db.select().from(areas);
  const allItems = await db.select().from(items);
  const allAtts = await db.select().from(attachments);
  const allRels = await db.select().from(relations);
  const itemMap = new Map(allItems.map((i) => [i.id, i]));
  const areaMap = new Map(allAreas.map((a) => [a.id, a]));

  const pages: Array<{ entityType: "area" | "item" | "index"; entityId: number; slug: string; title: string; content: string }> = [];

  for (const item of allItems) {
    const area = areaMap.get(item.areaId);
    const attTitles = allAtts
      .filter((a) => a.itemId === item.id)
      .map((a) => `${a.kind}: ${a.title ?? a.url ?? a.content?.slice(0, 80) ?? ""}`);
    const relLines = allRels
      .filter((r) => r.status === "confirmed" && (r.fromItemId === item.id || r.toItemId === item.id))
      .map((r) => {
        const otherId = r.fromItemId === item.id ? r.toItemId : r.fromItemId;
        const other = itemMap.get(otherId);
        return other ? `${r.type} → [[${itemSlug(other)}|${other.name}]]` : null;
      })
      .filter(Boolean) as string[];
    pages.push({
      entityType: "item",
      entityId: item.id,
      slug: itemSlug(item),
      title: item.name,
      content: renderItemPage(item, area, attTitles, relLines),
    });
  }

  for (const area of allAreas) {
    const areaItems = allItems.filter((i) => i.areaId === area.id && i.status === "active");
    const archived = allItems.filter((i) => i.areaId === area.id && i.status === "archived");
    pages.push({
      entityType: "area",
      entityId: area.id,
      slug: `area-${area.slug}`,
      title: area.name,
      content: [
        "---",
        `type: area`,
        `slug: ${area.slug}`,
        `items: ${areaItems.length}`,
        "---",
        "",
        `# ${area.name}`,
        "",
        area.description ?? "",
        "## Items",
        ...areaItems.map((i) => `- [[${itemSlug(i)}|${i.name}]]`),
        archived.length ? `\n## Archived` : "",
        ...archived.map((i) => `- [[${itemSlug(i)}|${i.name}]]`),
        "",
      ].join("\n"),
    });
  }

  pages.push({
    entityType: "index",
    entityId: 0,
    slug: "index",
    title: "HomeBase Wiki",
    content: [
      "# HomeBase Wiki",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Areas",
      ...allAreas.map((a) => {
        const count = allItems.filter((i) => i.areaId === a.id && i.status === "active").length;
        return `- [[area-${a.slug}|${a.name}]] — ${count} items`;
      }),
      "",
    ].join("\n"),
  });

  return pages;
}

export const wikiRouter = createRouter({
  list: procedure.query(async () => {
    return getDb().select().from(wikiPages).orderBy(desc(wikiPages.generatedAt));
  }),

  get: procedure.input(z.object({ slug: z.string() })).query(({ input }) =>
    getDb().query.wikiPages.findFirst({ where: eq(wikiPages.slug, input.slug) }),
  ),

  /** deterministic regeneration from live data — no AI required */
  generate: procedure.mutation(async () => {
    const db = getDb();
    const pages = await buildPages();
    let written = 0;
    for (const p of pages) {
      await db
        .insert(wikiPages)
        .values({ ...p, generatedAt: new Date() })
        .onDuplicateKeyUpdate({
          set: { content: p.content, title: p.title, generatedAt: new Date() },
        });
      written++;
    }
    await logEvent({
      entityType: "wiki",
      action: "generated",
      summary: `Wiki regenerated (${written} pages)`,
      actor: "system",
    });
    return { ok: true, pages: written };
  }),

  /** optional AI polish for one page */
  enhance: procedure.input(z.object({ slug: z.string() })).mutation(async ({ input }) => {
    const db = getDb();
    const page = await db.query.wikiPages.findFirst({ where: eq(wikiPages.slug, input.slug) });
    if (!page) throw new Error("page not found — generate the wiki first");
    try {
      const model = await getModel();
      const { text } = await generateText({
        model,
        prompt: `Rewrite this inventory wiki page to be more useful as LLM context: keep ALL facts and the frontmatter block exactly, keep [[wiki-links]] intact, but add a concise "Summary" section and, where obvious, "Insights" (e.g. consolidation opportunities, missing info). Return markdown only.\n\n${page.content}`,
      });
      await db
        .update(wikiPages)
        .set({ content: text, generatedAt: new Date() })
        .where(eq(wikiPages.slug, input.slug));
      await logEvent({
        entityType: "wiki",
        action: "enhanced",
        summary: `Wiki page "${page.title}" enhanced by AI`,
        actor: "ai",
      });
      return { ok: true as const };
    } catch (err) {
      const classified = classifyAiError(err);
      return { ok: false as const, error: classified.message };
    }
  }),

  /** single-file context pack to paste into any LLM */
  exportPack: procedure.query(async () => {
    const db = getDb();
    let pages = await db.select().from(wikiPages);
    if (!pages.length) {
      // generate on the fly
      const built = await buildPages();
      pages = built.map((p, i) => ({ id: i, ...p, generatedAt: new Date() }));
    }
    const ordered = [...pages].sort((a, b) => {
      const rank = (t: string) => (t === "index" ? 0 : t === "area" ? 1 : 2);
      return rank(a.entityType) - rank(b.entityType) || a.slug.localeCompare(b.slug);
    });
    const content = ordered
      .map((p) => `<!-- FILE: wiki/${p.slug}.md -->\n\n${p.content}`)
      .join("\n\n---\n\n");
    return { content, pageCount: ordered.length };
  }),
});
