#!/usr/bin/env node
// Backfill `type` and `tags` on existing Things by the evidence ladder
// (db/taxonomy.ts: judgeComputer, derivedType, tagsOf). Dry run by default.
//
//   node scripts/backfill-type.mjs                          # table, writes nothing
//   node scripts/backfill-type.mjs --base http://127.0.0.1:3002
//   node scripts/backfill-type.mjs --apply                  # verdict "computer" + role-derived types
//   node scripts/backfill-type.mjs --apply --ids 306,64     # additionally these "suggested" ones
//
// Only active, top-level Things without lab.exclude = yes are judged. Only the
// keys `type` and `tags` are written, via items.patchAttributes.
import { judgeComputer, derivedType, tagsOf, attrStr } from "../db/taxonomy.ts";

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = (arg("--base") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const APPLY = argv.includes("--apply");
const IDS = new Set((arg("--ids") ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean));

const enc = (o) => encodeURIComponent(JSON.stringify({ json: o }));
async function call(path, init) {
  const r = await fetch(`${BASE}/api/trpc/${path}`, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.error) throw new Error(`${path}: ${b.error?.json?.message ?? r.status}`);
  return b.result.data.json;
}
const query = (p, input) => call(`${p}?input=${enc(input)}`);
const mutate = (p, input) =>
  call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) });

try {
  const items = await query("items.listAll", { houseId: null });
  const rows = [];
  for (const it of items) {
    const attrs = it.attributes ?? {};
    if (it.status === "archived" || it.parentId != null || attrStr(attrs, "lab.exclude") === "yes") continue;
    const v = judgeComputer({ name: it.name, attributes: attrs });
    // Role mapping only: ignore a stored type so we can tell where a proposal comes from.
    const roleType = derivedType({ ...attrs, type: undefined });
    const type = v.type ?? roleType ?? null;
    const tags = [...tagsOf(attrs)];
    for (const t of v.tags ?? []) if (!tags.includes(t)) tags.push(t);
    const curType = attrStr(attrs, "type") ?? "";
    const curTags = attrStr(attrs, "tags") ?? "";
    const tagStr = tags.join(",");
    const change = type != null && (curType !== type || (tagStr !== "" && curTags !== tagStr));
    const safe = v.verdict === "computer" || (v.verdict !== "suggested" && v.type == null && roleType != null);
    rows.push({ it, v, type, tagStr, curType, change, safe, chosen: IDS.has(it.id) && v.verdict === "suggested" });
  }

  const cell = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 38);
  console.log(["id", "name", "role", "brand", "type now", "type new", "tags new", "rule", "verdict", "action"].join("\t"));
  const todo = [];
  for (const r of rows) {
    const a = r.it.attributes ?? {};
    const act = !r.change ? "-" : r.safe || r.chosen ? "write" : "review";
    if (act === "write") todo.push(r);
    console.log(
      [r.it.id, cell(r.it.name), attrStr(a, "role") ?? "", attrStr(a, "brand") ?? "", r.curType, r.type ?? "", r.tagStr, r.v.rule, r.v.verdict, act].join("\t"),
    );
  }
  const n = (k) => rows.filter((r) => r.v.verdict === k).length;
  console.log(
    `\nsummary: ${rows.length} Things judged; computer ${n("computer")}, suggested ${n("suggested")}, no ${n("no")}; ` +
      `${rows.filter((r) => r.change).length} would change, ${todo.length} written with this command`,
  );

  if (APPLY) {
    for (const r of todo) {
      const set = { type: r.type };
      if (r.tagStr) set.tags = r.tagStr;
      await mutate("items.patchAttributes", { id: r.it.id, set });
      console.log(`wrote #${r.it.id} ${r.it.name}: type=${r.type}${r.tagStr ? ` tags=${r.tagStr}` : ""}`);
    }
    console.log(`applied ${todo.length}`);
  } else {
    console.log("dry run: nothing written (use --apply)");
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
