// One-off batch: run the local detector + claude -p labeling pipeline
// against every pending image capture. Not wired into the app yet -
// this exercises api/lib/localDetector.ts and api/lib/claudeLabel.ts
// directly against the real DB to produce a reviewable batch of
// detected (unconfirmed) items.
import "dotenv/config";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { getDb } from "../api/queries/connection.ts";
import { detectObjectsLocal } from "../api/lib/localDetector.ts";
import { labelCropWithClaude } from "../api/lib/claudeLabel.ts";
import { cropPercent } from "../api/lib/crop.ts";
import { readFileBytes, putFile } from "../api/lib/filestore.ts";

const db = getDb();

const GENERIC_FALLBACK = [
  "sofa", "couch", "television", "soundbar", "remote control", "lamp",
  "air purifier", "video doorbell", "wireless charger", "decorative object",
  "dining chair", "dining table", "curtain", "cushion", "painting",
  "power strip", "tablet", "phone", "headphones", "speaker",
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
  console.log(`${pending.length} pending captures, ${allItems.length} known item names as candidates\n`);

  for (const cap of pending) {
    if (!cap.storageKey) continue;
    console.log(`--- capture #${cap.id} (${cap.storageKey}) ---`);
    const bytes = await readFileBytes(cap.storageKey);
    const detections = await detectObjectsLocal(bytes, candidateLabels, { threshold: 0.12, maxResults: 10 });

    const known = detections.filter((d) => itemByName.has(d.label));
    const unknown = detections.filter((d) => !itemByName.has(d.label));

    for (const d of known) {
      const item = itemByName.get(d.label);
      console.log(`  [known ${(d.score * 100).toFixed(0)}%] ${d.label} -> item #${item.id}`);
    }

    // label unmatched boxes via claude -p, in parallel (bounded)
    const labeled = await withConcurrency(unknown, 4, async (d) => {
      const cropped = await cropPercent(bytes, d.box);
      const label = await labelCropWithClaude(new Uint8Array(cropped));
      return { ...d, claudeLabel: label ?? d.label, cropped };
    });
    for (const d of labeled) {
      console.log(`  [new ${(d.score * 100).toFixed(0)}%] ${d.label} -> claude -p: "${d.claudeLabel}"`);
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
          description: "Detected locally (OWL-ViT) + labeled via claude -p, from a batch Telegram import",
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
