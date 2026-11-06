/** A frame on a Photo: centre + size, each 0-100 (percent of the Photo). */
export type CropBox = { xPct: number; yPct: number; wPct: number; hPct: number };

export const DEFAULT_CROP_BOX: CropBox = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 };

/** Centre + size to top-left + size, all in percent (for CSS left/top/width/height). */
export function frameRect(b: CropBox): { left: number; top: number; width: number; height: number } {
  return { left: b.xPct - b.wPct / 2, top: b.yPct - b.hPct / 2, width: b.wPct, height: b.hPct };
}

export function boxesEqual(a: CropBox, b: CropBox): boolean {
  return a.xPct === b.xPct && a.yPct === b.yPct && a.wPct === b.wPct && a.hPct === b.hPct;
}
