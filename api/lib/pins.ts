// api/lib/pins.ts
// Shared reads for photo pins: the item join that pins.listForPhoto and
// pins.listForRoom both need, and the room set a room page rolls up.
import { derivedType, tagsOf } from "@db/taxonomy";
import { inArray } from "drizzle-orm";
import { areas, items, photoPins, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;
type PinRow = typeof photoPins.$inferSelect;
type ItemRow = typeof items.$inferSelect;



/** The attributes a schematic block shows in its details; the rest stays on the item page. */
const DETAIL_KEYS = ["hostname", "ip", "os", "ram_gb", "storage_gb", "cpu", "brand"] as const;

/** A pinned Thing as the room's Schema view needs it: what it is, its tags, and its state. */
export function pinItemSummary(it: ItemRow) {
  const attrs = (it.attributes ?? {}) as Record<string, unknown>;
  const details: Partial<Record<(typeof DETAIL_KEYS)[number], string | number>> = {};
  for (const k of DETAIL_KEYS) {
    const v = attrs[k];
    if (typeof v === "string" || typeof v === "number") details[k] = v;
  }
  return {
    id: it.id,
    name: it.name,
    role: typeof attrs.role === "string" ? attrs.role : null,
    type: derivedType(attrs),
    tags: tagsOf(attrs),
    decision: it.decision ?? null,
    verificationStatus: it.verificationStatus,
    status: it.status,
    areaId: it.areaId,
    attributes: details,
  };
}

/** Pins without the dismissed ones, each with its linked Thing (null when
 * item-less or the item is gone) and the name, description and area colour
 * the pin marker shows. */
export async function withPinItems(db: Db, pins: PinRow[]) {
  const live = pins.filter((p) => p.status !== "dismissed");
  const itemIds = [...new Set(live.map((p) => p.itemId).filter((x): x is number => !!x))];
  const linked = itemIds.length ? await db.select().from(items).where(inArray(items.id, itemIds)) : [];
  const byId = new Map(linked.map((i) => [i.id, i]));
  // area color, not just name - the pin marker's fill reflects the
  // linked item's category, so a "black desk lamp" and a "Sonos
  // speaker" read differently on the photo at a glance
  const areaIds = [...new Set(linked.map((i) => i.areaId))];
  const areaRows = areaIds.length ? await db.select({ id: areas.id, color: areas.color }).from(areas).where(inArray(areas.id, areaIds)) : [];
  const areaColorById = new Map(areaRows.map((a) => [a.id, a.color]));
  return live.map((p) => {
    const it = p.itemId ? (byId.get(p.itemId) ?? null) : null;
    return {
      pin: p,
      linked: it,
      itemName: it?.name ?? null,
      itemDescription: it?.description ?? null,
      itemAreaColor: it ? (areaColorById.get(it.areaId) ?? null) : null,
    };
  });
}

/** The room and every room cut from it, recursively (the set rooms.get rolls up). */
export async function roomWithDescendants(db: Db, roomId: number): Promise<number[]> {
  const out = [roomId];
  const seen = new Set(out);
  let frontier = [roomId];
  for (let depth = 0; frontier.length && depth < 50; depth++) {
    const children = await db.select({ id: rooms.id }).from(rooms).where(inArray(rooms.parentRoomId, frontier));
    frontier = children.map((c) => c.id).filter((id) => !seen.has(id));
    for (const id of frontier) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

