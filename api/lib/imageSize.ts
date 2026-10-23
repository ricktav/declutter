import sharp from "sharp";

/**
 * Pixel size of an image as a browser would display it: EXIF orientations
 * 5–8 swap width and height. Header-only (no decode), so list/backfill
 * can probe many files without reading pixels.
 */
export async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(Buffer.from(bytes)).metadata();
    if (!meta.width || !meta.height) return null;
    const o = meta.orientation ?? 1;
    return o >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

/** width/height columns for a photo insert/update; nulls when the file is not an image. */
export async function imageSizeFields(bytes: Uint8Array): Promise<{ width: number | null; height: number | null }> {
  const size = await imageSize(bytes);
  return { width: size?.width ?? null, height: size?.height ?? null };
}
