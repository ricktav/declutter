#!/usr/bin/env node
// One-off data cleanup (2026-11-08, AGENTS.md §2 "scan_kind"):
// The 155 Things that the Cursor "wes" session created on 27–28 Oct 2026 for
// Josies (house 4) and Mtv (house 5) carry `scan_kind: "wes-scan-object"`, a
// value no scanner ever sends. They were described from photos, not detected
// in a floor scan, and none of them has a position. The rescan matcher
// (`api/lib/scanMerge.ts`) only looks at Things with a position, so the key is
// inert today and misleading tomorrow: once such a Thing is placed by hand, a
// rescan would flag it missing and could never match it. Clearing the key
// makes them what they are: hand-registered Things. `scan_slug` stays, so the
// provenance is kept.
// Dry run by default; `--apply` writes through tRPC so events are logged.
//
//   node scripts/clear-scan-kind-2026-11.mjs
//   node scripts/clear-scan-kind-2026-11.mjs --apply [--base http://127.0.0.1:3001]
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = (arg("--base") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const APPLY = argv.includes("--apply");
const VALUE = "wes-scan-object";

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

const items = await query("items.listAll", { houseId: null });
const rooms = await query("rooms.list", { houseId: null });
const houseOf = new Map(rooms.map((r) => [r.id, r.houseId]));

const hits = items.filter((i) => i.attributes?.scan_kind === VALUE);
const positioned = hits.filter((i) => i.pos != null);
const byHouse = {};
for (const i of hits) { const h = houseOf.get(i.roomId) ?? "none"; byHouse[h] = (byHouse[h] ?? 0) + 1; }

console.log(`scan_kind "${VALUE}": ${hits.length} Things`, byHouse);
if (positioned.length) {
  console.log(`  ${positioned.length} of them have a position (left alone, decide by hand):`);
  for (const i of positioned) console.log(`    #${i.id} ${i.name}`);
}
const todo = hits.filter((i) => i.pos == null);
console.log(`  clearing on ${todo.length} unpositioned Things${APPLY ? "" : " (dry run)"}`);
let n = 0;
for (const it of todo) {
  if (APPLY) await mutate("items.patchAttributes", { id: it.id, set: { scan_kind: null } });
  n++;
}
console.log(APPLY ? `Applied: ${n} cleared.` : "Dry run; add --apply to write.");
