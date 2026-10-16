#!/usr/bin/env node
// Drop leftover duplicate storage_volumes rows on one machine (computer + its
// disk Things): same device+mount, UUID, or label vs path. Keeps the freshest
// measuredAt. Disk Thing twins (enclosure vs the drive inside it, import-created
// #324–327 vs an existing Thing) are listed as merge offers — never deleted
// unless you pass --merge-disks with --apply.
// Dry unless --apply.
//   node scripts/storage-dedupe-volumes.mjs
//   node scripts/storage-dedupe-volumes.mjs --apply
//   node scripts/storage-dedupe-volumes.mjs --apply --merge-disks
//   --base http://localhost:3001
import "dotenv/config";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : next;
}

const apply = args.apply === true && args.dry !== true;
const mergeDisks = args["merge-disks"] === true;
const base = String(args.base || process.env.HOMEBASE_BASE || "http://localhost:3001").replace(/\/$/, "");
const headers = {
  "content-type": "application/json",
  ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
};

async function trpc(path, input) {
  const res = await fetch(`${base}/api/trpc/${path}`, { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  const data = body.result?.data;
  if (data && typeof data === "object" && "json" in data) return data.json;
  return data;
}

const plan = await trpc("storage.dedupeVolumes", { dry: !apply, mergeDisks: apply && mergeDisks });
const fmtVol = (g) => {
  const drops = g.drop.map((d) => `#${d.id} ${d.itemName} ${d.mountPoint} ${d.source}`).join("; ");
  const tag = g.ambiguous ? " · SKIP ambiguous (different mountpoints)" : "";
  return `${g.machineName}#${g.machineId}: keep volume #${g.keep.id} ${g.keep.mountPoint} on ${g.keep.itemName} · drop ${drops}${tag}`;
};
const volLines = (plan.volumes ?? []).filter((g) => !g.ambiguous).map(fmtVol);
const skippedLines = (plan.skipped ?? plan.volumes?.filter((g) => g.ambiguous) ?? []).map(fmtVol);
const mergeLines = (plan.diskMerges ?? []).map((m) => {
  const extras = m.drop.map((d) => `#${d.id} ${d.name}`).join(", ");
  return `${m.machineName}#${m.machineId}: keep #${m.keep.id} ${m.keep.name} · merge ${extras} (${m.reason})`;
});
console.log(
  JSON.stringify(
    {
      dry: plan.dry,
      droppedVolumes: plan.droppedVolumes,
      skippedVolumes: plan.skippedVolumes ?? skippedLines.length,
      mergedDisks: plan.mergedDisks,
      volumeDupes: volLines,
      skipped: skippedLines,
      diskMerges: mergeLines,
    },
    null,
    2,
  ),
);
if (!apply) console.error("dry run: pass --apply to delete duplicate volume rows (ambiguous groups are skipped); --merge-disks also unparents extra disk Things");
else if (skippedLines.length) console.error(`${skippedLines.length} ambiguous group(s) skipped; the rest were applied`);
else if (mergeLines.length && !mergeDisks) console.error("disk Thing twins listed above were not merged; pass --merge-disks with --apply to unparent the extras");
