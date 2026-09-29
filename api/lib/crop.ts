import sharp from "sharp";

/**
 * Cut a region out of an image. Box is expressed in percentages of the
 * ORIGINAL image (xPct/yPct = center, wPct/hPct = size), so a snap and its
 * cutouts stay in sync however the image is displayed.
 * Pads the box a little and clamps to the image bounds.
 */
export async function cropPercent(
  input: Uint8Array,
  box: { xPct: number; yPct: number; wPct: number; hPct: number },
): Promise<Buffer> {
  const meta = await sharp(Buffer.from(input)).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const pad = 4; // % padding around the box so the object isn't tight-cropped
  let w = ((box.wPct + pad) / 100) * W;
  let h = ((box.hPct + pad) / 100) * H;
  let x = (box.xPct / 100) * W - w / 2;
  let y = (box.yPct / 100) * H - h / 2;
  x = Math.max(0, Math.min(x, W - 1));
  y = Math.max(0, Math.min(y, H - 1));
  w = Math.min(w, W - x);
  h = Math.min(h, H - y);
  return sharp(Buffer.from(input))
    .extract({ left: Math.round(x), top: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) })
    .jpeg({ quality: 88 })
    .toBuffer();
}

/**
 * Downscale an image for use as vision-model context (reference photos,
 * candidate crops) where full resolution just adds request size/latency
 * without adding identification value.
 */
export async function toThumbnail(input: Uint8Array, maxDim = 320): Promise<Buffer> {
  return sharp(Buffer.from(input))
    .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}
