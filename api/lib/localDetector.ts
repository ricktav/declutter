import sharp from "sharp";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

export type DetectionSource = "owl" | "florence";

export interface LocalDetection {
  label: string;
  score: number;
  box: { xPct: number; yPct: number; wPct: number; hPct: number };
  source?: DetectionSource;
}

/** Legacy zero-shot model. Kept behind LOCAL_DETECTOR_MODEL=owlvit. */
export const OWL_VIT_MODEL = "Xenova/owlvit-base-patch32";
/** Default for known item names: better labels and more spread-out scores. */
export const OWL_V2_MODEL = "Xenova/owlv2-base-patch16-ensemble";
/** Open-vocabulary detector for everything OWL was not asked to name. */
export const FLORENCE_MODEL = "onnx-community/Florence-2-base-ft";

const MODEL_ALIASES: Record<string, string> = {
  owlvit: OWL_VIT_MODEL,
  "owl-vit": OWL_VIT_MODEL,
  owlv2: OWL_V2_MODEL,
  "owl-v2": OWL_V2_MODEL,
};

const FALSEY = new Set(["0", "false", "off", "no"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const detectorByModel = new Map<string, Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let florencePromise: Promise<any> | null = null;

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

/** Florence-2 OD is on by default; LOCAL_DETECTOR_FLORENCE=0 / opts.florence: false skips it. */
export function isFlorenceEnabled(opts?: { florence?: boolean }): boolean {
  if (typeof opts?.florence === "boolean") return opts.florence;
  const v = process.env.LOCAL_DETECTOR_FLORENCE;
  if (v == null || v.trim() === "") return true;
  return !FALSEY.has(v.trim().toLowerCase());
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

async function getFlorence() {
  if (!florencePromise) {
    const modelId = process.env.LOCAL_DETECTOR_FLORENCE_MODEL?.trim() || FLORENCE_MODEL;
    florencePromise = import("@huggingface/transformers").then(async (tf) => {
      const model = await tf.Florence2ForConditionalGeneration.from_pretrained(modelId, { dtype: "fp32" });
      const processor = await tf.AutoProcessor.from_pretrained(modelId);
      return { model, processor, load_image: tf.load_image };
    });
  }
  return florencePromise;
}

async function withTempImage<T>(imageBytes: Uint8Array, fn: (tmpPath: string) => Promise<T>): Promise<T> {
  const tmpPath = path.join(os.tmpdir(), `local-detect-${crypto.randomBytes(6).toString("hex")}.jpg`);
  await fs.writeFile(tmpPath, Buffer.from(imageBytes));
  try {
    return await fn(tmpPath);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

function boxFromPixels(
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  width: number,
  height: number,
): LocalDetection["box"] {
  const W = width || 1;
  const H = height || 1;
  return {
    xPct: ((xmin + xmax) / 2 / W) * 100,
    yPct: ((ymin + ymax) / 2 / H) * 100,
    wPct: ((xmax - xmin) / W) * 100,
    hPct: ((ymax - ymin) / H) * 100,
  };
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
 * Merge OWL (known names + generic prompts) with Florence-2 OD ("everything
 * else"). Same overlap filter as nms (IoU > 0.35). Known-name OWL hits are
 * kept even when a Florence box scores higher and overlaps them; remaining
 * OWL hits then compete with Florence on score (Florence has none, so 0).
 */
export function mergeDetections(
  owl: LocalDetection[],
  florence: LocalDetection[],
  opts: { preferLabels?: Iterable<string>; iouThresh?: number } = {},
): LocalDetection[] {
  const iouThresh = opts.iouThresh ?? 0.35;
  const prefer = new Set(
    [...(opts.preferLabels ?? [])].map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const isPreferred = (d: LocalDetection) => prefer.has(d.label.trim().toLowerCase());
  const preferred = owl.filter(isPreferred);
  const otherOwl = owl.filter((d) => !isPreferred(d));
  const kept: LocalDetection[] = [];
  for (const d of [...preferred].sort((a, b) => b.score - a.score)) {
    if (!kept.some((k) => iou(k.box, d.box) > iouThresh)) kept.push(d);
  }
  const rest = [...otherOwl, ...florence].sort((a, b) => b.score - a.score);
  for (const d of rest) {
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

  const raw = await withTempImage(
    imageBytes,
    (tmpPath) =>
      detector(tmpPath, candidateLabels, {
        threshold: resolveOwlThreshold(model, opts.threshold),
        topk: 100,
      }) as Promise<Array<{ label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }>>,
  );

  const asPercent: LocalDetection[] = raw.map((r) => ({
    label: r.label,
    score: r.score,
    source: "owl" as const,
    box: boxFromPixels(r.box.xmin, r.box.ymin, r.box.xmax, r.box.ymax, W, H),
  }));

  return nms(asPercent).slice(0, opts.maxResults ?? 15);
}

function imageDims(image: { size?: unknown; width?: number; height?: number }): { width: number; height: number } {
  const s = image.size;
  if (Array.isArray(s) && s.length >= 2 && Number.isFinite(s[0]) && Number.isFinite(s[1])) {
    return { width: Number(s[0]), height: Number(s[1]) };
  }
  if (s && typeof s === "object" && "width" in s && "height" in s) {
    const rec = s as { width: number; height: number };
    return { width: rec.width, height: rec.height };
  }
  return { width: image.width ?? 1, height: image.height ?? 1 };
}

function decodeFlorenceText(
  processor: { batch_decode?: (ids: unknown, opts: { skip_special_tokens: boolean }) => unknown; tokenizer?: { batch_decode?: (ids: unknown, opts: { skip_special_tokens: boolean }) => unknown } },
  generatedIds: unknown,
): string {
  const out =
    processor.batch_decode?.(generatedIds, { skip_special_tokens: false }) ??
    processor.tokenizer?.batch_decode?.(generatedIds, { skip_special_tokens: false });
  if (out == null) throw new Error("Florence-2 processor has no batch_decode");
  return Array.isArray(out) ? String(out[0] ?? "") : String(out);
}

function parseFlorenceOd(result: unknown): Array<{ label: string; xmin: number; ymin: number; xmax: number; ymax: number }> {
  if (!result || typeof result !== "object") return [];
  const rec = result as Record<string, unknown>;
  const inner = (rec["<OD>"] ?? rec) as Record<string, unknown>;
  const bboxes = Array.isArray(inner.bboxes) ? inner.bboxes : [];
  const labels = Array.isArray(inner.labels) ? inner.labels : [];
  const out: Array<{ label: string; xmin: number; ymin: number; xmax: number; ymax: number }> = [];
  for (let i = 0; i < bboxes.length; i++) {
    const b = bboxes[i];
    let xmin: number, ymin: number, xmax: number, ymax: number;
    if (Array.isArray(b) && b.length >= 4) {
      xmin = Number(b[0]); ymin = Number(b[1]); xmax = Number(b[2]); ymax = Number(b[3]);
    } else if (b && typeof b === "object" && "xmin" in (b as object)) {
      const box = b as { xmin: number; ymin: number; xmax: number; ymax: number };
      xmin = Number(box.xmin); ymin = Number(box.ymin); xmax = Number(box.xmax); ymax = Number(box.ymax);
    } else {
      continue;
    }
    const label = String(labels[i] ?? "").trim();
    if (!label || ![xmin, ymin, xmax, ymax].every(Number.isFinite)) continue;
    out.push({ label, xmin, ymin, xmax, ymax });
  }
  return out;
}

function isUsefulBox(box: LocalDetection["box"]): boolean {
  if (!(box.wPct > 0 && box.hPct > 0)) return false;
  // skip whole-scene boxes (wall / floor / the room itself)
  if ((box.wPct * box.hPct) / 100 > 70) return false;
  return true;
}

/**
 * Florence-2 `<OD>`: finds most of the real objects in a room photo with
 * almost no false hits. No scores; labels are its own names (pass them as a
 * hint to claude -p). Local ONNX only — no API.
 */
export async function detectObjectsFlorence(
  imageBytes: Uint8Array,
  opts: { maxResults?: number } = {},
): Promise<LocalDetection[]> {
  const { model, processor, load_image } = await getFlorence();
  const meta = await sharp(Buffer.from(imageBytes)).metadata();
  const fallbackW = meta.width ?? 1;
  const fallbackH = meta.height ?? 1;

  const parsed = await withTempImage(imageBytes, async (tmpPath) => {
    const image = await load_image(tmpPath);
    const task = "<OD>";
    const prompts = processor.construct_prompts(task);
    const inputs = await processor(image, prompts);
    const generated = await model.generate({ ...inputs, max_new_tokens: 512 });
    const generatedIds =
      generated && typeof generated === "object" && "sequences" in generated ? generated.sequences : generated;
    const generatedText = decodeFlorenceText(processor, generatedIds);
    const dims = imageDims(image);
    // RawImage.size is [width, height]; post_process scales x by size[0] and y by size[1].
    const processed = processor.post_process_generation(generatedText, task, image.size ?? [dims.width, dims.height]);
    return { rows: parseFlorenceOd(processed), width: dims.width || fallbackW, height: dims.height || fallbackH };
  });

  const asPercent: LocalDetection[] = parsed.rows
    .map((r) => ({
      label: r.label,
      score: 0,
      source: "florence" as const,
      box: boxFromPixels(r.xmin, r.ymin, r.xmax, r.ymax, parsed.width, parsed.height),
    }))
    .filter((d) => isUsefulBox(d.box));

  return nms(asPercent).slice(0, opts.maxResults ?? 15);
}

export type DetectSceneOpts = {
  threshold?: number;
  maxResults?: number;
  model?: string;
  florence?: boolean;
  knownLabels?: Iterable<string>;
};

/**
 * OWLv2 (or OWL-ViT) for names we already know, plus Florence-2 for
 * everything else, merged with the overlap filter. Known-name OWL hits win
 * on overlap. Does not download anything when `florence: false`.
 */
export async function detectSceneLocal(
  imageBytes: Uint8Array,
  candidateLabels: string[],
  opts: DetectSceneOpts = {},
): Promise<LocalDetection[]> {
  const cap = opts.maxResults ?? 15;
  const owl = await detectObjectsLocal(imageBytes, candidateLabels, {
    threshold: opts.threshold,
    model: opts.model,
    maxResults: 100,
  });
  const florence = isFlorenceEnabled(opts)
    ? await detectObjectsFlorence(imageBytes, { maxResults: 100 })
    : [];
  return mergeDetections(owl, florence, { preferLabels: opts.knownLabels }).slice(0, cap);
}
