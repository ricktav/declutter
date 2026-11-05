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

/** Legacy zero-shot model. Kept behind LOCAL_DETECTOR_MODEL=owlvit. */
export const OWL_VIT_MODEL = "Xenova/owlvit-base-patch32";
/** Default for known item names: better labels and more spread-out scores. */
export const OWL_V2_MODEL = "Xenova/owlv2-base-patch16-ensemble";

const MODEL_ALIASES: Record<string, string> = {
  owlvit: OWL_VIT_MODEL,
  "owl-vit": OWL_VIT_MODEL,
  owlv2: OWL_V2_MODEL,
  "owl-v2": OWL_V2_MODEL,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const detectorByModel = new Map<string, Promise<any>>();

/**
 * Zero-shot object detector (OWL-ViT / OWLv2), running locally via ONNX -
 * no API call, no per-photo cost. Lazily loaded once per model id and kept
 * warm; first call pays a one-time model-download+load cost.
 *
 * Default is OWLv2 @ 0.30 (known-name hits land around 0.35–0.68). The old
 * OWL-ViT patch32 @ 0.12 path is still available via env/option: scores sat
 * too close together and it mixed up labels (poster→television, notebook→tablet).
 */
export function resolveOwlModel(model?: string): string {
  const raw = (model ?? process.env.LOCAL_DETECTOR_MODEL ?? OWL_V2_MODEL).trim();
  if (!raw) return OWL_V2_MODEL;
  return MODEL_ALIASES[raw.toLowerCase()] ?? raw;
}

export function defaultThresholdFor(model: string): number {
  return resolveOwlModel(model) === OWL_VIT_MODEL ? 0.12 : 0.3;
}

export function resolveOwlThreshold(model: string, threshold?: number): number {
  if (threshold != null) return threshold;
  const env = process.env.LOCAL_DETECTOR_THRESHOLD;
  if (env != null && env !== "") {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return defaultThresholdFor(model);
}

async function getDetector(model: string) {
  const id = resolveOwlModel(model);
  let pending = detectorByModel.get(id);
  if (!pending) {
    pending = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("zero-shot-object-detection", id),
    );
    detectorByModel.set(id, pending);
  }
  return pending;
}

export function iou(a: LocalDetection["box"], b: LocalDetection["box"]): number {
  const ax1 = a.xPct - a.wPct / 2, ay1 = a.yPct - a.hPct / 2, ax2 = a.xPct + a.wPct / 2, ay2 = a.yPct + a.hPct / 2;
  const bx1 = b.xPct - b.wPct / 2, by1 = b.yPct - b.hPct / 2, bx2 = b.xPct + b.wPct / 2, by2 = b.yPct + b.hPct / 2;
  const x1 = Math.max(ax1, bx1), y1 = Math.max(ay1, by1);
  const x2 = Math.min(ax2, bx2), y2 = Math.min(ay2, by2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.wPct * a.hPct, areaB = b.wPct * b.hPct;
  const denom = areaA + areaB - inter;
  return denom <= 0 ? 0 : inter / denom;
}

export function nms(dets: LocalDetection[], iouThresh = 0.35): LocalDetection[] {
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
 *
 * Model and threshold: `opts.model` / `opts.threshold` win, else
 * LOCAL_DETECTOR_MODEL / LOCAL_DETECTOR_THRESHOLD, else OWLv2 @ 0.30.
 * Aliases: `owlvit` (legacy patch32 @ 0.12), `owlv2`.
 */
export async function detectObjectsLocal(
  imageBytes: Uint8Array,
  candidateLabels: string[],
  opts: { threshold?: number; maxResults?: number; model?: string } = {},
): Promise<LocalDetection[]> {
  const model = resolveOwlModel(opts.model);
  const detector = await getDetector(model);
  const meta = await sharp(Buffer.from(imageBytes)).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;

  // the pipeline's image loader wants a path/URL, not raw bytes - stage a temp file
  const tmpPath = path.join(os.tmpdir(), `local-detect-${crypto.randomBytes(6).toString("hex")}.jpg`);
  await fs.writeFile(tmpPath, Buffer.from(imageBytes));
  let raw: Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>;
  try {
    raw = await detector(tmpPath, candidateLabels, {
      threshold: resolveOwlThreshold(model, opts.threshold),
      topk: 100,
    });
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
