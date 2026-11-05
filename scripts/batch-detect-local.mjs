// One-off batch: run the local detector + claude -p labeling pipeline
// against every pending image capture. Not wired into the app yet -
// this exercises api/lib/localDetector.ts and api/lib/claudeLabel.ts
// directly against the real DB to produce a reviewable batch of
// detected (unconfirmed) items.
//
// Default: OWLv2 @ 0.30 for known names, Florence-2 OD for everything else,
// then claude -p names unknown crops (Florence/generic labels are a hint).
// First run downloads the ONNX weights into the transformers.js cache.
//
//   node scripts/batch-detect-local.mjs
//   node scripts/batch-detect-local.mjs --model owlvit --no-florence
//   LOCAL_DETECTOR_MODEL=owlvit LOCAL_DETECTOR_FLORENCE=0 node scripts/batch-detect-local.mjs
//   node scripts/batch-detect-local.mjs --threshold 0.35
import "dotenv/config";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { getDb } from "../api/queries/connection.ts";
import {
  detectSceneLocal,
  isFlorenceEnabled,
  resolveOwlModel,
  resolveOwlThreshold,
} from "../api/lib/localDetector.ts";
import { labelCropWithClaude } from "../api/lib/claudeLabel.ts";
import { cropPercent } from "../api/lib/crop.ts";
import { readFileBytes, putFile } from "../api/lib/filestore.ts";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("-")) return process.argv[i + 1];
  return undefined;
}

function scoreBit(d) {
  if (d.source === "florence") return "florence";
  return `${(d.score * 100).toFixed(0)}%`;
}

const cliModel = argValue("--model");
const cliThreshold = argValue("--threshold");
const florenceOn = process.argv.includes("--no-florence")
  ? false
  : process.argv.includes("--florence")
    ? true
    : isFlorenceEnabled();
const detectOpts = {
  maxResults: 10,
  florence: florenceOn,
  ...(cliModel ? { model: cliModel } : {}),
  ...(cliThreshold != null && Number.isFinite(Number(cliThreshold)) ? { threshold: Number(cliThreshold) } : {}),
};

const db = getDb();

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
  const areaRow = await db.query.areas.findFirst({ where: eq(schema.areas.slug, "woonkamer") });
  let areaId = areaRow?.id;
  if (!areaId) {
    const [{ id }] = await db
      .insert(schema.areas)
      .values({ slug: "woonkamer", name: "Woonkamer", icon: "sofa", color: "#8b6f47" })
      .$returningId();
    areaId = id;
    console.log(`created area "Woonkamer" (id ${areaId})`);
  }

  const allItems = await db.select().from(schema.items).where(eq(schema.items.status, "active"));
  const itemByName = new Map(allItems.map((it) => [it.name, it]));
  const candidateLabels = [...allItems.map((it) => it.name), ...GENERIC_FALLBACK];

  const pending = await db.query.captures.findMany({ where: eq(schema.captures.status, "pending") });
  const owlId = resolveOwlModel(cliModel);
  console.log(
    `detector ${owlId} @ ${resolveOwlThreshold(owlId, detectOpts.threshold)}; florence ${florenceOn ? "on" : "off"}`,
  );
  console.log(`${pending.length} pending captures, ${allItems.length} known item names as candidates\n`);

  for (const cap of pending) {
    if (!cap.storageKey) continue;
    console.log(`--- capture #${cap.id} (${cap.storageKey}) ---`);
    const bytes = await readFileBytes(cap.storageKey);
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

    // label unmatched boxes via claude -p, in parallel (bounded).
    // Florence (and generic OWL) labels go in as a hint, not the final name.
    const labeled = await withConcurrency(unknown, 4, async (d) => {
      const cropped = await cropPercent(bytes, d.box);
      const label = await labelCropWithClaude(new Uint8Array(cropped), { hint: d.label });
      return { ...d, claudeLabel: label ?? d.label, cropped };
    });
    for (const d of labeled) {
      console.log(`  [new ${scoreBit(d)}] ${d.label} -> claude -p: "${d.claudeLabel}"`);
    }

    // file: known -> cutout on existing item; new -> detected item + cutout
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
          description: "Detected locally + labeled via claude -p, from a batch Telegram import",
          verificationStatus: "detected",
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
      console.log(`  filed new item #${itemId}: "${d.claudeLabel}" (needs confirmation)`);
    }

    await db.update(schema.captures).set({ status: "triaged" }).where(eq(schema.captures.id, cap.id));
    console.log();
  }

  console.log("done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
