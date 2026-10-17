import { and, desc, eq } from "drizzle-orm";
import { items, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";
import { coverPhotos } from "./photos";
import { readFileBytes } from "./filestore";
import { toThumbnail } from "./crop";

type Db = ReturnType<typeof getDb>;

export const MAX_REFERENCE_PHOTOS = 20;

export type DetectInventoryItem = {
  id: number;
  name: string;
  houseId: number | null;
  description: string | null;
};

export type DetectBox = { xPct: number; yPct: number; wPct: number; hPct: number };

/**
 * House used to match detected objects to Things.
 * The photo's own Place (room → house) wins. An explicit Focus house or a
 * capture stamp is only a fallback when the photo has no room. Null means
 * label-only pins: do not invent a match from another house's inventory.
 */
export function pickDetectHouseId(opts: {
  photoHouseId?: number | null;
  explicitHouseId?: number | null;
  captureHouseId?: number | null;
}): number | null {
  return opts.photoHouseId ?? opts.explicitHouseId ?? opts.captureHouseId ?? null;
}

export async function houseIdForRoom(db: Db, roomId: number | null | undefined): Promise<number | null> {
  if (roomId == null) return null;
  const [row] = await db.select({ houseId: rooms.houseId }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return row?.houseId ?? null;
}

export async function loadHouseInventory(db: Db, houseId: number | null): Promise<DetectInventoryItem[]> {
  if (houseId == null) return [];
  return db
    .select({ id: items.id, name: items.name, houseId: items.houseId, description: items.description })
    .from(items)
    .where(and(eq(items.status, "active"), eq(items.houseId, houseId)))
    .orderBy(desc(items.updatedAt));
}

/** Token overlap; same approach as the items router. */
export function nameScore(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Link a detection to an inventory row. `inventory` must already be scoped to
 * the photo's house (or empty). A matchedItemId from another house is ignored.
 */
export function matchDetectedItem(
  label: string,
  matchedItemId: number | null | undefined,
  inventory: DetectInventoryItem[],
): { itemId: number | null; via: "visual" | "name" | null; score: number } {
  const byId = new Map(inventory.map((it) => [it.id, it]));
  if (matchedItemId != null && byId.has(matchedItemId)) {
    return { itemId: matchedItemId, via: "visual", score: 1 };
  }
  let best = 0;
  let itemId: number | null = null;
  for (const it of inventory) {
    const s = nameScore(label, it.name);
    if (s > best) {
      best = s;
      itemId = it.id;
    }
  }
  if (best < 0.5) return { itemId: null, via: null, score: best };
  return { itemId, via: "name", score: best };
}

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

export function detectInventoryPrompt(inventory: { id: number; name: string }[]): string {
  if (!inventory.length) {
    return "No inventory is in scope for this photo (no Place/house, or none yet). Leave matchedItemId null. Do not match an item from another house.";
  }
  return `Existing inventory IN THIS HOUSE only (name-based context; not all have a reference photo). Never set matchedItemId to an id that is not in this list:\n${inventory
    .slice(0, 200)
    .map((i) => `- ${i.id}: ${i.name}`)
    .join("\n")}`;
}

export type RefContentPart = { type: "text"; text: string } | { type: "image"; image: Uint8Array };

/** Reference photos of in-scope items only, so the model cannot see another house. */
export async function buildReferenceContent(
  db: Db,
  inventory: { id: number; name: string }[],
  limit: number,
): Promise<RefContentPart[]> {
  const photoByItem = new Map(
    [...(await coverPhotos(db, inventory.map((it) => it.id)))].map(([itemId, p]) => [itemId, p.storageKey] as const),
  );
  const refItems = inventory.filter((it) => photoByItem.has(it.id)).slice(0, limit);
  const refContent: RefContentPart[] = [];
  for (const it of refItems) {
    try {
      const refBytes = await toThumbnail(await readFileBytes(photoByItem.get(it.id)!));
      refContent.push({ type: "text", text: `Reference photo — existing item [id ${it.id}]: "${it.name}"` });
      refContent.push({ type: "image", image: refBytes });
    } catch {
      // file missing on disk — skip this one reference, not fatal
    }
  }
  return refContent;
}
