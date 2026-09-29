import sharp from "sharp";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

export interface LocalDetection {
  label: string;
  score: number;
  box: { xPct: number; yPct: number; wPct: number; hPct: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let detectorPromise: Promise<any> | null = null;

/**
 * Zero-shot object detector (OWL-ViT), running locally via ONNX - no API
 * call, no per-photo cost. Lazily loaded once and kept warm; first call
 * pays a one-time model-download+load cost, subsequent calls are ~300ms
 * on Apple Silicon.
 */
async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("zero-shot-object-detection", "Xenova/owlvit-base-patch32"),
    );
  }
  return detectorPromise;
}

function iou(a: LocalDetection["box"], b: LocalDetection["box"]): number {
  const ax1 = a.xPct - a.wPct / 2, ay1 = a.yPct - a.hPct / 2, ax2 = a.xPct + a.wPct / 2, ay2 = a.yPct + a.hPct / 2;
  const bx1 = b.xPct - b.wPct / 2, by1 = b.yPct - b.hPct / 2, bx2 = b.xPct + b.wPct / 2, by2 = b.yPct + b.hPct / 2;
  const x1 = Math.max(ax1, bx1), y1 = Math.max(ay1, by1);
  const x2 = Math.min(ax2, bx2), y2 = Math.min(ay2, by2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.wPct * a.hPct, areaB = b.wPct * b.hPct;
  return inter / (areaA + areaB - inter);
}

function nms(dets: LocalDetection[], iouThresh = 0.35): LocalDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: LocalDetection[] = [];
  for (const d of sorted) {
    if (!kept.some((k) => iou(k.box, d.box) > iouThresh)) kept.push(d);
  }
  return kept;
}

/**
 * Detect objects matching any of `candidateLabels` (zero-shot text prompts -
 * pass real item names to get correctly-identified, tightly-boxed results
 * for anything already in inventory; pass generic categories to also catch
 * new objects). Returns de-duplicated, percent-of-image boxes.
 */
export async function detectObjectsLocal(
  imageBytes: Uint8Array,
  candidateLabels: string[],
  opts: { threshold?: number; maxResults?: number } = {},
): Promise<LocalDetection[]> {
  const detector = await getDetector();
  const meta = await sharp(Buffer.from(imageBytes)).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;

  // the pipeline's image loader wants a path/URL, not raw bytes - stage a temp file
  const tmpPath = path.join(os.tmpdir(), `local-detect-${crypto.randomBytes(6).toString("hex")}.jpg`);
  await fs.writeFile(tmpPath, Buffer.from(imageBytes));
  let raw: Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>;
  try {
    raw = await detector(tmpPath, candidateLabels, { threshold: opts.threshold ?? 0.12, topk: 100 });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }

  const asPercent: LocalDetection[] = raw.map((r) => ({
    label: r.label,
    score: r.score,
    box: {
      xPct: ((r.box.xmin + r.box.xmax) / 2 / W) * 100,
      yPct: ((r.box.ymin + r.box.ymax) / 2 / H) * 100,
      wPct: ((r.box.xmax - r.box.xmin) / W) * 100,
      hPct: ((r.box.ymax - r.box.ymin) / H) * 100,
    },
  }));

  return nms(asPercent).slice(0, opts.maxResults ?? 15);
}
