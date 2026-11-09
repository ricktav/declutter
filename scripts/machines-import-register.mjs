#!/usr/bin/env node
// Fill computer Things from the machine register (Data Tracker /api/machines):
// serial, uuid, model, machine.id, hostname, aliases, ip, mac, macs. Matching
// is by serial, then machine.id, then a card's MAC (hardware, strong);
// hostname / IP matches are "weak" and only written with --accept-weak. Dry by default: prints the plan.
//
//   node scripts/machines-import-register.mjs
//   node scripts/machines-import-register.mjs --apply
//   node scripts/machines-import-register.mjs --apply --accept-weak
//   REGISTER_URL=http://10.50.0.10:8888/api/machines HOMEBASE_BASE=http://127.0.0.1:3001
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = (arg("--base") ?? process.env.HOMEBASE_BASE ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const REGISTER_URL = arg("--register") ?? process.env.REGISTER_URL ?? "http://10.50.0.10:8888/api/machines";
const APPLY = argv.includes("--apply");
const ACCEPT_WEAK = argv.includes("--accept-weak");

const reg = await fetch(REGISTER_URL, { signal: AbortSignal.timeout(15_000) });
if (!reg.ok) throw new Error(`${REGISTER_URL}: HTTP ${reg.status}`);
const machines = await reg.json();

const r = await fetch(`${BASE}/api/trpc/machines.importRegister`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ json: { machines, dry: !APPLY, acceptWeak: ACCEPT_WEAK } }),
});
const body = await r.json().catch(() => ({}));
if (!r.ok || body.error) throw new Error(`machines.importRegister: ${body.error?.json?.message ?? r.status}`);
const res = body.result.data.json;

const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(`${res.dry ? "DRY RUN" : "APPLIED"} — ${res.counts.machines} machines, ${res.counts.matched} matched (${res.counts.strong} strong, ${res.counts.weak} weak), ${res.counts.conflicts} with conflicts, ${res.counts.noThing} without a Thing\n`);
for (const row of res.rows) {
  const head = `${pad(row.machine.canonical, 18)} ${pad(row.machine.serial ?? "-", 17)} → ${row.itemId != null ? `#${row.itemId} ${row.itemName}` : "(no Thing)"}`;
  const how = row.matchedBy ? ` [${row.matchedBy}${row.strong ? "" : ", weak"}]` : "";
  console.log(head + how + (row.skipped ? `  SKIP: ${row.skipped}` : ""));
  for (const [k, v] of Object.entries(row.set)) console.log(`    ${pad(k, 11)} = ${v}`);
  for (const c of row.conflicts) console.log(`    CONFLICT ${c.key}: HomeBase "${c.have}" vs register "${c.want}" (row not applied)`);
}
if (res.unmatchedItems.length) {
  console.log(`\nComputer Things without a register machine (${res.unmatchedItems.length}):`);
  for (const it of res.unmatchedItems) console.log(`  #${it.id} ${it.name}`);
}
if (!res.dry) console.log(`\nWrote ${res.applied.length} Things: ${res.applied.map((a) => `#${a.itemId}`).join(" ")}`);
else console.log("\nDry run; add --apply (and --accept-weak for hostname/IP matches) to write.");
