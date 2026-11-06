import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { DETECT_VISION_MAX_EDGE, forDetectVision, normalizeOrientation } from "../crop";

async function jpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg();
  if (orientation != null) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

describe("normalizeOrientation / forDetectVision", () => {
  it("bakes EXIF orientation 6 so percent boxes share the browser's upright frame", async () => {
    // 64×48 landscape pixels tagged 90° CW display as 48×64 portrait, which
    // is what <img> naturalWidth/Height and FramedRoomPhoto aspect-ratio use
    const raw = await jpeg(64, 48, 6);
    const rawMeta = await sharp(raw).metadata();
    expect(rawMeta.orientation).toBe(6);
    expect([rawMeta.width, rawMeta.height]).toEqual([64, 48]);

    const upright = await normalizeOrientation(raw);
    const up = await sharp(upright).metadata();
    expect([up.width, up.height, up.orientation ?? 1]).toEqual([48, 64, 1]);

    const vision = await forDetectVision(raw);
    const vis = await sharp(vision).metadata();
    expect([vis.width, vis.height, vis.format]).toEqual([48, 64, "jpeg"]);
  });

  it("caps a large upright photo on the long edge without changing aspect", async () => {
    const raw = await jpeg(2000, 1000);
    const vision = await forDetectVision(raw);
    const vis = await sharp(vision).metadata();
    expect(vis.width).toBe(DETECT_VISION_MAX_EDGE);
    expect(vis.height).toBe(DETECT_VISION_MAX_EDGE / 2);
  });
});
