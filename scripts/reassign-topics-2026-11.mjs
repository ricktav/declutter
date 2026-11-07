#!/usr/bin/env node
// One-off data cleanup (2026-11-07, AGENTS.md §5 Topic / Type / Kind):
//  1. Free-text `type` values that are not TYPE_TREE nodes are moved into the
//     Thing's description (when empty) and the `type` key is cleared.
//  2. The 155 scan-imported Things (scan_kind wes-scan-object) in the catch-all
//     Topic "Things" get a real Topic; five Topics are created for what the
//     eight existing ones do not cover.
// Dry run by default; `--apply` writes through tRPC so events are logged.
//
//   node scripts/reassign-topics-2026-11.mjs
//   node scripts/reassign-topics-2026-11.mjs --apply [--base http://127.0.0.1:3001]
import { isTypeNode } from "../db/taxonomy.ts";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = (arg("--base") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const APPLY = argv.includes("--apply");

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

const NEW_TOPICS = [
  { slug: "sports", name: "Sports", icon: "dumbbell", color: "#f97316", description: "Fitness and sports gear" },
  { slug: "textiles", name: "Textiles & clothing", icon: "shirt", color: "#ec4899", description: "Blankets, cushions, towels, clothes" },
  { slug: "toys", name: "Toys", icon: "toy-brick", color: "#eab308", description: "Toys and games" },
  { slug: "kitchen", name: "Kitchen", icon: "utensils", color: "#14b8a6", description: "Cookware and kitchen utensils" },
  { slug: "containers", name: "Bags, boxes & bins", icon: "package", color: "#78716c", description: "Bags, suitcases, storage boxes, baskets and bins" },
];

// Thing id → topic slug. Every id is a scan-imported Thing now in "things".
const ASSIGN = {
  furniture: [351, 350, 349, 348, 353, 377, 354, 378, 396, 347, 336, 478, 467, 468, 469, 470, 475, 483, 403, 359, 493, 492, 375],
  decor: [383, 374, 392, 373, 423, 399, 362, 397, 360, 398, 376, 357, 404, 481, 482, 410, 381, 420, 382],
  textiles: [466, 474, 337, 415, 342, 343, 477, 384, 401, 400, 339, 338, 388, 402, 340, 341, 346, 407, 484, 428, 429, 472, 421],
  toys: [411, 405, 419, 412, 416, 408, 361, 358, 414, 393],
  kitchen: [367, 370, 368, 369, 371, 345],
  containers: [364, 363, 385, 391, 390, 442, 422, 406, 387, 356, 355, 413, 409, 389, 352, 365, 344, 386, 380, 486, 372, 473, 490, 491, 476],
  sports: [441, 436, 439, 454, 455, 456, 457, 458, 459, 460, 452, 453, 366, 464, 443, 444, 445, 446, 447, 448, 449, 450, 451, 424, 437, 438, 425, 465, 463, 433, 431, 432, 435, 430, 426, 427, 462, 440, 461],
  appliances: [479, 471, 489, 487, 488, 434, 395],
  electronics: [480, 485],
};

const seen = new Map();
for (const [slug, ids] of Object.entries(ASSIGN)) for (const id of ids) {
  if (seen.has(id)) throw new Error(`id ${id} in both ${seen.get(id)} and ${slug}`);
  seen.set(id, slug);
}

const items = await query("items.listAll", { houseId: null });
const byId = new Map(items.map((i) => [i.id, i]));
let areas = await query("areas.list", {});
const areaBySlug = () => new Map(areas.map((a) => [a.slug, a]));
const thingsArea = areaBySlug().get("things");

// 1. free-text types
const freeText = items.filter((i) => i.attributes?.type != null && !isTypeNode(String(i.attributes.type)));
console.log(`\n== 1. free-text Type → description (${freeText.length}) ==`);
for (const it of freeText) {
  const t = String(it.attributes.type);
  const desc = it.description?.trim() ? it.description : t;
  console.log(`  #${it.id} ${it.name}: type "${t}" → cleared${it.description?.trim() ? " (description kept)" : ", description set"}`);
  if (APPLY) {
    await mutate("items.patchAttributes", { id: it.id, set: { type: null } });
    if (desc !== it.description) await mutate("items.update", { id: it.id, description: desc });
  }
}

// 2. topics
console.log(`\n== 2. new Topics ==`);
for (const t of NEW_TOPICS) {
  if (areaBySlug().has(t.slug)) { console.log(`  ${t.slug}: exists`); continue; }
  console.log(`  ${t.slug}: create "${t.name}"`);
  if (APPLY) await mutate("areas.create", t);
}
if (APPLY) areas = await query("areas.list", {});

console.log(`\n== 3. Things → Topic ==`);
const counts = {};
const skipped = [];
for (const [id, slug] of seen) {
  const it = byId.get(id);
  if (!it) { skipped.push(`#${id}: not found`); continue; }
  if (it.areaId !== thingsArea?.id) { skipped.push(`#${id} ${it.name}: not in "things" (area ${it.areaId})`); continue; }
  const area = areaBySlug().get(slug);
  counts[slug] = (counts[slug] ?? 0) + 1;
  if (APPLY) {
    if (!area) throw new Error(`topic ${slug} missing`);
    await mutate("items.update", { id, areaId: area.id });
  }
}
for (const [slug, n] of Object.entries(counts).sort()) console.log(`  ${slug.padEnd(12)} ${n}`);
if (skipped.length) { console.log("  skipped:"); for (const s of skipped) console.log("   ", s); }
const left = items.filter((i) => i.areaId === thingsArea?.id && i.status !== "archived" && !seen.has(i.id));
console.log(`\n  still in "Things" afterwards (${left.length}):`);
for (const i of left) console.log(`    #${i.id} ${i.name}`);
console.log(APPLY ? "\nApplied." : "\nDry run; add --apply to write.");
