export type DetectBox = { xPct: number; yPct: number; wPct: number; hPct: number };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function overflows(left: number, top: number, right: number, bottom: number): boolean {
  return left < -0.5 || top < -0.5 || right > 100.5 || bottom > 100.5;
}

/**
 * Make a model box match FramedRoomPhoto / cropPercent: xPct/yPct is CENTER,
 * wPct/hPct is size, all 0–100 of the upright image (EXIF already applied).
 *
 * Models often emit top-left (x,y) anyway, or 0–1 fractions, or a box that
 * hangs off the edge — those land beside the object on screen. Convert and
 * clamp here so a stored pin's percent overlay sits on the same pixels the
 * crop path would extract.
 */
export function normalizeDetectBox(raw: {
  xPct: number;
  yPct: number;
  wPct?: number | null;
  hPct?: number | null;
}): DetectBox | null {
  let x = raw.xPct;
  let y = raw.yPct;
  let w = raw.wPct ?? 0;
  let h = raw.hPct ?? 0;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;

  // 0–1 fractions mistaken for percents. A real 1×1% box at (0.5, 0.5) is
  // vanishingly rare; the usual miss is x=0.48 y=0.63 w=0.12 h=0.10.
  if (x <= 1 && y <= 1 && w <= 1 && h <= 1) {
    x *= 100;
    y *= 100;
    w *= 100;
    h *= 100;
  }

  const centerOverflows = overflows(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
  const topLeftFits = !overflows(x, y, x + w, y + h);
  if (centerOverflows && topLeftFits) {
    x += w / 2;
    y += h / 2;
  }

  w = clamp(w, 1, 100);
  h = clamp(h, 1, 100);
  x = clamp(x, w / 2, 100 - w / 2);
  y = clamp(y, h / 2, 100 - h / 2);
  return { xPct: x, yPct: y, wPct: w, hPct: h };
}

/** Shared with pins.detect and inbox.detectObjects — centre+size, upright image. */
export const DETECT_BOX_INSTRUCTIONS = `For each object give a bounding box that FULLY CONTAINS the object (a little margin is fine; a box on one corner or a tiny 4–6% square on a large object is wrong).
xPct/yPct is the box CENTER as a percentage of image width/height — NOT the top-left corner. wPct/hPct is the box width/height as a percentage of the image. All four numbers are 0–100. The whole box must stay inside the image.
The photo is already upright (EXIF orientation baked in). Measure percentages against this image as you see it, the same way the browser displays it.`;
