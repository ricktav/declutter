// Local detector batch over pending image captures.
// Not wired into the app. Default is a dry-run: reads DB + image bytes,
// runs OWLv2 (+ Florence unless disabled), prints a plan. No DB writes,
// no putFile, no crops, no claude -p / API naming.
//
//   node scripts/batch-detect-local.mjs                  # dry-run, all pending
//   node scripts/batch-detect-local.mjs --limit 15
//   node scripts/batch-detect-local.mjs --apply          # write cutouts + detected Things
//   node scripts/batch-detect-local.mjs --apply --no-label
//   node scripts/batch-detect-local.mjs --model owlvit --no-florence
//
// Files: putFile (apply only) writes under path.resolve(cwd, "uploads") —
// this process's working directory, not a hardcoded production tree. Running
// from /Volumes/T7/declutter would touch live uploads; a worktree writes
// that worktree's ./uploads. Dry-run never calls putFile. Image *reads* still
// use that same folder (capture storageKey).
//
// Never deletes Things. Point DATABASE_URL at a disposable DB for experiments.
import "dotenv/config";
import path from "path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { getDb } from "../api/queries/connection.ts";
import {
  detectSceneLocal,
  isFlorenceEnabled,
  resolveOwlModel,
  resolveOwlThreshold,
} from "../api/lib/localDetector.ts";
import { formatPlace, knownItemsForPlace, parseBatchDetectCli, resolveCapturePlace } from "../api/lib/batchDetect.ts";
import { defaultAreaId } from "../api/lib/defaultTopic.ts";
import { labelCropWithClaude } from "../api/lib/claudeLabel.ts";
import { cropPercent } from "../api/lib/crop.ts";
import { readFileBytes, putFile, uploadsRoot } from "../api/lib/filestore.ts";

const GENERIC_FALLBACK = [
  "sofa", "couch", "television", "soundbar", "remote control", "lamp",
  "air purifier", "video doorbell", "wireless charger", "decorative object",
  "dining chair", "dining table", "curtain", "cushion", "painting",
  "power strip", "tablet", "phone", "headphones", "speaker",
  // desk / storage — the living-room list missed these on shelf and desk photos
  "box", "storage box", "cardboard box", "plastic box",
  "computer monitor", "monitor", "keyboard", "computer keyboard", "mouse",
  "laptop", "book", "notebook", "bag", "backpack", "handbag",
  "cable", "power cable", "usb cable", "bottle", "water bottle",
  "shelf", "bookshelf", "desk", "drawer",
  "hard drive", "external drive", "router", "printer",
  "charger", "power adapter",
];

function argHas(flag) {
  return process.argv.includes(flag);
}

function scoreBit(d) {
  if (d.source === "florence") return "florence";
  return `${(d.score * 100).toFixed(0)}%`;
}

function printHelp() {
  console.log(`Local batch detector (OWLv2 + Florence-2). Default: dry-run, no writes.

Usage:
  node scripts/batch-detect-local.mjs [options]

  (default)          Plan only: detect, print, do not write
  --dry-run          Same as default (wins over --apply)
  --apply            File cutouts / detected Things and mark captures triaged
  --limit N, -n N    First N pending captures with a file
  --no-label         Skip claude -p even with --apply (use detector labels)
  --model owlvit|owlv2|<hf-id>
  --threshold 0.30
  --florence / --no-florence
  --max-results 10
  --florence-reserve 3

putFile writes to ${path.resolve(process.cwd(), "uploads")} (cwd-relative).
`);
}

async function withConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function main() {
  if (argHas("--help") || argHas("-h")) {
    printHelp();
    process.exit(0);
  }

  const cli = parseBatchDetectCli(process.argv);
  const florenceOn = cli.florence ?? isFlorenceEnabled();
  const detectOpts = {
    maxResults: cli.maxResults,
    florence: florenceOn,
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.threshold != null ? { threshold: cli.threshold } : {}),
    ...(cli.florenceReserve != null ? { florenceReserve: cli.florenceReserve } : {}),
  };

  const db = getDb();
  const owlId = resolveOwlModel(cli.model);
  const uploads = uploadsRoot();
  console.log(
    `mode ${cli.apply ? "APPLY" : "dry-run"}; detector ${owlId} @ ${resolveOwlThreshold(owlId, cli.threshold)}; florence ${florenceOn ? "on" : "off"}; naming ${cli.label ? "claude -p" : "off"}`,
  );
  console.log(`uploads ${uploads} (cwd-relative; dry-run does not write files)`);

  const allItems = await db.select().from(schema.items).where(eq(schema.items.status, "active"));
  let pending = (await db.query.captures.findMany({ where: eq(schema.captures.status, "pending") })).filter(
    (c) => c.storageKey,
  );
  if (cli.limit != null) pending = pending.slice(0, cli.limit);

  const capIds = pending.map((c) => c.id);
  const locRows = capIds.length
    ? await db
        .select({
          id: schema.photos.id,
          sourceCaptureId: schema.photos.sourceCaptureId,
          roomId: schema.photos.roomId,
        })
        .from(schema.photos)
        .where(and(inArray(schema.photos.sourceCaptureId, capIds), isNull(schema.photos.itemId)))
    : [];
  const locBy = new Map();
  for (const l of locRows) {
    if (l.sourceCaptureId == null) continue;
    const prev = locBy.get(l.sourceCaptureId);
    if (!prev || l.id < prev.id) locBy.set(l.sourceCaptureId, l);
  }
  const roomIds = [...new Set([...locBy.values()].map((l) => l.roomId).filter((id) => id != null))];
  const roomRows = roomIds.length
    ? await db
        .select({ id: schema.rooms.id, name: schema.rooms.name, houseId: schema.rooms.houseId })
        .from(schema.rooms)
        .where(inArray(schema.rooms.id, roomIds))
    : [];
  const roomBy = new Map(roomRows.map((r) => [r.id, r]));
  const houseIds = [
    ...new Set(
      [...roomRows.map((r) => r.houseId), ...pending.map((c) => c.houseId), ...allItems.map((i) => i.houseId)].filter(
        (id) => id != null,
      ),
    ),
  ];
  const houseRows = houseIds.length
    ? await db.select({ id: schema.houses.id, name: schema.houses.name }).from(schema.houses).where(inArray(schema.houses.id, houseIds))
    : [];
  const houseBy = new Map(houseRows.map((h) => [h.id, h]));

  console.log(`${pending.length} pending captures, ${allItems.length} active Things in DB\n`);

  let areaId = null;
  if (cli.apply) areaId = await defaultAreaId(db);

  for (const cap of pending) {
    const loc = locBy.get(cap.id);
    const room = loc?.roomId != null ? roomBy.get(loc.roomId) : undefined;
    const place = resolveCapturePlace({
      captureHouseId: cap.houseId,
      locationRoomId: loc?.roomId ?? null,
      locationHouseId: room?.houseId ?? null,
    });
    const scoped = knownItemsForPlace(allItems, place);
    const itemByName = new Map(scoped.map((it) => [it.name, it]));
    const candidateLabels = [...itemByName.keys(), ...GENERIC_FALLBACK];
    const placeBit = formatPlace(place, {
      roomName: room?.name ?? null,
      houseName: place.houseId != null ? (houseBy.get(place.houseId)?.name ?? null) : null,
    });

    console.log(`--- capture #${cap.id} (${cap.storageKey}) — ${placeBit}; ${scoped.length} known names ---`);

    let bytes;
    try {
      bytes = await readFileBytes(cap.storageKey);
    } catch (err) {
      console.log(`  skip: cannot read file from ${uploads}: ${err.message ?? err}`);
      continue;
    }

    const detections = await detectSceneLocal(bytes, candidateLabels, {
      ...detectOpts,
      knownLabels: itemByName.keys(),
    });

    const known = detections.filter((d) => itemByName.has(d.label));
    const unknown = detections.filter((d) => !itemByName.has(d.label));

    for (const d of known) {
      const item = itemByName.get(d.label);
      console.log(`  [known ${scoreBit(d)}] ${d.label} -> item #${item.id}`);
    }
    for (const d of unknown) {
      console.log(`  [new ${scoreBit(d)}] ${d.label}${d.source === "florence" ? " (florence)" : ""}`);
    }

    if (!cli.apply) {
      console.log(`  dry-run: would file ${known.length} known cutout(s), ${unknown.length} new Thing(s) at ${placeBit}`);
      console.log();
      continue;
    }

    const labeled = cli.label
      ? await withConcurrency(unknown, 4, async (d) => {
          const cropped = await cropPercent(bytes, d.box);
          const name = await labelCropWithClaude(new Uint8Array(cropped), { hint: d.label });
          return { ...d, claudeLabel: name ?? d.label, cropped };
        })
      : await withConcurrency(unknown, 4, async (d) => {
          const cropped = await cropPercent(bytes, d.box);
          return { ...d, claudeLabel: d.label, cropped };
        });
    for (const d of labeled) {
      if (cli.label) console.log(`  named "${d.claudeLabel}" (hint ${d.label})`);
    }

    for (const d of known) {
      const item = itemByName.get(d.label);
      const cropped = await cropPercent(bytes, d.box);
      const saved = await putFile({
        bytes: new Uint8Array(cropped),
        fileName: `items/${item.id}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      await db.insert(schema.photos).values({
        itemId: item.id,
        areaId: item.areaId,
        title: `Cutout: ${item.name}`,
        storageKey: saved.key,
        mimeType: "image/jpeg",
        size: saved.size,
        sourceCaptureId: cap.id,
        cropBox: d.box,
      });
    }
    for (const d of labeled) {
      const [{ id: itemId }] = await db
        .insert(schema.items)
        .values({
          areaId,
          name: d.claudeLabel,
          description: "Detected locally from a batch import",
          verificationStatus: "detected",
          roomId: place.roomId,
          houseId: place.houseId,
        })
        .$returningId();
      const saved = await putFile({
        bytes: new Uint8Array(d.cropped),
        fileName: `items/${itemId}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      await db.insert(schema.photos).values({
        itemId,
        areaId,
        title: `Cutout: ${d.claudeLabel}`,
        storageKey: saved.key,
        mimeType: "image/jpeg",
        size: saved.size,
        sourceCaptureId: cap.id,
        cropBox: d.box,
      });
      console.log(`  filed new item #${itemId}: "${d.claudeLabel}" at ${placeBit} (needs confirmation)`);
    }

    await db.update(schema.captures).set({ status: "triaged" }).where(eq(schema.captures.id, cap.id));
    console.log();
  }

  console.log(cli.apply ? "done." : "dry-run done. Pass --apply to write.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
