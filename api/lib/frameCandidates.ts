// One candidate per source for a Thing on a Photo. Sources do not overwrite
// each other. The frame a screen shows is the winner: a confirmed user or
// Focus frame beats any model; otherwise the highest quality, then the
// newest. Dismissed candidates stay in the table and never win.
import { and, eq } from "drizzle-orm";
import { photoPins, type FrameSource, type PhotoPin } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;
type Tx = Pick<Db, "select" | "insert" | "update">;

/** Fixed ranks when the writer has no model confidence. Model scores stay
 * in 0–100. `confirm` is Rick confirming a candidate; it outranks every
 * model score but does not by itself beat a user or Focus frame. */
export const FRAME_QUALITY = {
  confirm: 1000,
  user: 90,
  focus: 80,
  inbox: 50,
  batch: 40,
} as const;

export function batchQuality(score: number | null | undefined): number {
  if (score == null || !(score > 0)) return FRAME_QUALITY.batch;
  return Math.max(1, Math.min(100, Math.round(score * 100)));
}

type PinLike = Pick<PhotoPin, "id" | "photoId" | "itemId" | "status" | "source" | "origin" | "quality" | "createdAt">;

/** A person drew this frame, or it is a legacy user pin from before sources. */
export function isHumanFrame(pin: Pick<PhotoPin, "status" | "source" | "origin">): boolean {
  if (pin.status !== "confirmed") return false;
  if (pin.source === "user" || pin.source === "focus") return true;
  return pin.source == null && pin.origin === "user";
}

function timeOf(pin: Pick<PhotoPin, "createdAt">): number {
  const t = pin.createdAt instanceof Date ? pin.createdAt.getTime() : new Date(pin.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** True when `a` should be shown instead of `b`. */
function beats(a: PinLike, b: PinLike, byQuality: boolean): boolean {
  if (byQuality) {
    const aq = a.quality ?? 0;
    const bq = b.quality ?? 0;
    if (aq !== bq) return aq > bq;
  }
  const at = timeOf(a);
  const bt = timeOf(b);
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

/** The frame to show for one Thing on one Photo, or null when every
 * candidate is dismissed. */
export function winningPin<T extends PinLike>(pins: T[]): T | null {
  const live = pins.filter((p) => p.status !== "dismissed");
  if (!live.length) return null;
  const human = live.filter(isHumanFrame);
  const pool = human.length ? human : live;
  const byQuality = human.length === 0;
  return pool.reduce((best, pin) => (beats(pin, best, byQuality) ? pin : best));
}

/** One winner per Thing on each Photo. A pin with no Thing is not in that
 * contest yet, so it stays (unless it was dismissed). Input order is kept. */
export function winningPins<T extends PinLike>(pins: T[]): T[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const pin of pins) {
    const key = pin.itemId == null ? `open:${pin.id}` : `${pin.photoId}:${pin.itemId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(pin);
  }
  const out: T[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (key.startsWith("open:")) {
      if (group[0].status !== "dismissed") out.push(group[0]);
      continue;
    }
    const win = winningPin(group);
    if (win) out.push(win);
  }
  return out;
}

/** What listForPhoto / listForItem / listForRoom return: the winner, plus
 * dismissed rows when the caller asked to see them. */
export function pinsForRead<T extends PinLike>(pins: T[], includeDismissed = false): T[] {
  const winners = winningPins(pins);
  if (!includeDismissed) return winners;
  const seen = new Set(winners.map((p) => p.id));
  return [...winners, ...pins.filter((p) => p.status === "dismissed" && !seen.has(p.id))];
}

function isWholeScene(pin: { wPct?: number | null; hPct?: number | null }): boolean {
  return pin.wPct === 0 && pin.hPct === 0;
}

const STATUS_RANK = { confirmed: 0, suggested: 1, dismissed: 2 } as const;

export interface FrameCandidateInput {
  photoId: number;
  itemId: number | null;
  source: FrameSource;
  quality: number;
  xPct: number;
  yPct: number;
  wPct?: number | null;
  hPct?: number | null;
  label: string;
  origin: "user" | "ai";
  status: "suggested" | "confirmed" | "dismissed";
  /** Move this source's box. False keeps a real frame already stored for
   * the same source; a whole-scene link still upgrades to a real crop. */
  replaceBox?: boolean;
  /** A row with no source yet may become this candidate. A user/Focus write
   * adopts an old user pin; a model write adopts an old AI pin. A row that
   * already names another source is never taken. */
  adoptUnsourced?: boolean;
}

/** Insert this source's candidate, or update that same source's row.
 * Another source's row is left untouched. */
export async function registerFrameCandidate(
  tx: Tx,
  input: FrameCandidateInput,
): Promise<{ id: number; created: boolean }> {
  const values = {
    photoId: input.photoId,
    itemId: input.itemId,
    xPct: input.xPct,
    yPct: input.yPct,
    wPct: input.wPct ?? null,
    hPct: input.hPct ?? null,
    label: input.label.slice(0, 255),
    origin: input.origin,
    status: input.status,
    source: input.source,
    quality: input.quality,
  };
  if (input.itemId == null) {
    const [{ id }] = await tx.insert(photoPins).values(values).$returningId();
    return { id, created: true };
  }

  const mine = await tx
    .select()
    .from(photoPins)
    .where(and(eq(photoPins.photoId, input.photoId), eq(photoPins.itemId, input.itemId)))
    .for("update");
  const prefer = (rows: PhotoPin[]) =>
    [...rows].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id - b.id)[0];
  const same = prefer(mine.filter((p) => p.source === input.source));
  const legacy = input.adoptUnsourced
    ? prefer(
        mine.filter((p) => {
          if (p.source != null) return false;
          // a person already drew this, before sources existed: only a
          // person may claim it. A model may claim an old AI suggestion.
          return input.source === "user" || input.source === "focus" ? p.origin === "user" : p.origin !== "user";
        }),
      )
    : undefined;
  const existing = same ?? legacy;
  if (!existing) {
    const [{ id }] = await tx.insert(photoPins).values(values).$returningId();
    return { id, created: true };
  }

  const patch: Partial<typeof photoPins.$inferInsert> = {};
  if (existing.source == null) patch.source = input.source;
  patch.quality = Math.max(existing.quality ?? 0, input.quality);
  // confirming sticks; a later suggestion does not un-confirm this source
  if (input.status === "confirmed" || existing.status !== "confirmed") patch.status = input.status;

  const upgrade = isWholeScene(existing) && !isWholeScene(input);
  if (input.replaceBox || upgrade) {
    patch.xPct = input.xPct;
    patch.yPct = input.yPct;
    if (input.wPct !== undefined || upgrade) patch.wPct = input.wPct ?? null;
    if (input.hPct !== undefined || upgrade) patch.hPct = input.hPct ?? null;
    // an empty label means "leave it": onePerThing omits a new name when it
    // only moves the frame
    if (input.label && (upgrade || input.replaceBox)) patch.label = input.label.slice(0, 255);
  }
  await tx.update(photoPins).set(patch).where(eq(photoPins.id, existing.id));
  return { id: existing.id, created: false };
}
