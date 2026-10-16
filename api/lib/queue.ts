import { and, eq, inArray, isNull } from "drizzle-orm";
import { areas, captures, items, photos, relations, rooms, type ItemDecision } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

/** A "Later" Thing comes back to be decided after this many days. */
export const LATER_DAYS = 7;

export const QUEUE_LENSES = ["lab"] as const;
export type QueueLens = (typeof QUEUE_LENSES)[number];

export type QueueThing = {
  id: number;
  status: string;
  verificationStatus: string;
  roomId: number | null;
  parentId: number | null;
  decision: ItemDecision | null;
  decidedAt: Date | string | null;
  areaSlug: string | null;
  attributes: Record<string, unknown> | null;
};

/** A rejected detection is not a real Thing: it never needs anything. */
export const isReal = (it: QueueThing) => it.verificationStatus !== "rejected";
export const needsCheck = (it: QueueThing) => it.status === "active" && it.verificationStatus === "detected";
export const needsPlace = (it: QueueThing) =>
  it.status === "active" && isReal(it) && !needsCheck(it) && it.roomId == null;
export function needsDecision(it: QueueThing, now: Date): boolean {
  if (it.status !== "active" || !isReal(it) || needsCheck(it)) return false;
  if (it.decision == null) return true;
  if (it.decision !== "later" || !it.decidedAt) return false;
  return now.getTime() - new Date(it.decidedAt).getTime() > LATER_DAYS * 86_400_000;
}

// The Computer lab lens. Same rules as Flow's src/flow/lenses.ts.
const LAB_AREA_SLUGS = ["computers", "network"];
/** Roles that can hold personal data: they need a backup before they go. */
const DATA_ROLES = new Set(["laptop", "desktop", "server", "nas", "storage", "phone", "sbc"]);

const attr = (it: QueueThing, key: string) => it.attributes?.[key];
const role = (it: QueueThing) => String(attr(it, "role") ?? "");

export function inLab(it: QueueThing): boolean {
  if (attr(it, "lab.exclude") === "yes") return false;
  if (role(it) === "meter") return false;
  if (role(it)) return true;
  return !!it.areaSlug && LAB_AREA_SLUGS.includes(it.areaSlug);
}

/** A data device that is not inside a computer, has no `backs-up` relation and was not marked as needing none. */
export function needsBackup(it: QueueThing, backedUp: ReadonlySet<number>): boolean {
  if (!DATA_ROLES.has(role(it))) return false;
  if (it.parentId != null) return false;
  if (backedUp.has(it.id)) return false;
  return attr(it, "lab.backup") !== "none-needed";
}

export type ThingQueue = {
  toCheck: number[];
  toPlace: number[];
  toDecide: number[];
  lens: { needsRole: number[]; needsBackup: number[] } | null;
};

export function classify(
  things: QueueThing[],
  opts: { now: Date; lens?: QueueLens | null; backedUp?: ReadonlySet<number> },
): ThingQueue {
  const lab = opts.lens === "lab";
  const scoped = lab ? things.filter(inLab) : things;
  const ready = scoped.filter((it) => it.status === "active" && isReal(it) && !needsCheck(it));
  return {
    toCheck: scoped.filter(needsCheck).map((it) => it.id),
    toPlace: scoped.filter(needsPlace).map((it) => it.id),
    toDecide: scoped.filter((it) => needsDecision(it, opts.now)).map((it) => it.id),
    lens: lab
      ? {
          needsRole: ready.filter((it) => !role(it)).map((it) => it.id),
          needsBackup: ready.filter((it) => needsBackup(it, opts.backedUp ?? new Set())).map((it) => it.id),
        }
      : null,
  };
}

export type QueueScope = { houseId: number | null; roomId?: number | null; lens?: QueueLens | null };

/**
 * What still needs a person, in one house (null = every house):
 * pending snaps to sort, detected Things to check, Things without a Place,
 * Things to decide (including a "Later" that is due again), and the lens's
 * own questions. A snap whose house is unknown counts in every house, since
 * it has to be sorted somewhere.
 */
export async function queueFor(db: Db, scope: QueueScope, now = new Date()) {
  const things = await db
    .select({
      id: items.id,
      status: items.status,
      verificationStatus: items.verificationStatus,
      roomId: items.roomId,
      parentId: items.parentId,
      decision: items.decision,
      decidedAt: items.decidedAt,
      areaSlug: areas.slug,
      attributes: items.attributes,
    })
    .from(items)
    .leftJoin(areas, eq(areas.id, items.areaId))
    .where(
      and(
        eq(items.status, "active"),
        scope.houseId != null ? eq(items.houseId, scope.houseId) : undefined,
        scope.roomId != null ? eq(items.roomId, scope.roomId) : undefined,
      ),
    );

  let backedUp = new Set<number>();
  if (scope.lens === "lab" && things.length) {
    const rels = await db
      .select({ toItemId: relations.toItemId })
      .from(relations)
      .where(eq(relations.type, "backs-up"));
    backedUp = new Set(rels.map((r) => r.toItemId));
  }

  const thingQueue = classify(things as QueueThing[], { now, lens: scope.lens, backedUp });
  const toSort = await pendingSnaps(db, scope);
  return {
    toSort,
    ...thingQueue,
    laterDays: LATER_DAYS,
    counts: {
      toSort: toSort.length,
      toCheck: thingQueue.toCheck.length,
      toPlace: thingQueue.toPlace.length,
      toDecide: thingQueue.toDecide.length,
      needsRole: thingQueue.lens?.needsRole.length ?? 0,
      needsBackup: thingQueue.lens?.needsBackup.length ?? 0,
    },
  };
}

/** Pending snaps, oldest first. A snap's Place is its location Photo's room, its house that room's house, else the snap's own house. */
async function pendingSnaps(db: Db, scope: QueueScope): Promise<number[]> {
  const rows = await db
    .select({ id: captures.id, houseId: captures.houseId })
    .from(captures)
    .where(eq(captures.status, "pending"))
    .orderBy(captures.createdAt, captures.id);
  if (!rows.length || (scope.houseId == null && scope.roomId == null)) return rows.map((r) => r.id);

  const locs = await db
    .select({ id: photos.id, captureId: photos.sourceCaptureId, roomId: photos.roomId, houseId: rooms.houseId })
    .from(photos)
    .leftJoin(rooms, eq(rooms.id, photos.roomId))
    .where(and(inArray(photos.sourceCaptureId, rows.map((r) => r.id)), isNull(photos.itemId)));
  const locBy = new Map<number, (typeof locs)[number]>();
  for (const l of locs) {
    if (l.captureId == null) continue;
    const prev = locBy.get(l.captureId);
    if (!prev || l.id < prev.id) locBy.set(l.captureId, l);
  }
  return rows
    .filter((c) => {
      const loc = locBy.get(c.id);
      if (scope.roomId != null) return loc?.roomId === scope.roomId;
      const houseId = loc?.houseId ?? c.houseId ?? null;
      return houseId == null || houseId === scope.houseId;
    })
    .map((c) => c.id);
}
