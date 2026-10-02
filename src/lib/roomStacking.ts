import type { ItemPos } from "@db/schema";

export type StackableItem = {
  id: number;
  pos: ItemPos | null;
};

const round2 = (v: number) => +v.toFixed(2);

/** Whatever contains this footprint's center and is bigger than it (a desk,
 * a table) is its stacking host - ported from lidarventory's findHost().
 * Shared by RoomPlan2D's drag-move and the pin-creation flow (2D and 3D),
 * so a new item dropped onto a table gets stacked the same as a dragged one. */
export function findHost<T extends StackableItem>(id: number, pos: ItemPos, items: T[]): (T & { pos: ItemPos }) | null {
  const cx = pos.xM + pos.wM / 2, cy = pos.yM + pos.dM / 2;
  const area = pos.wM * pos.dM;
  for (const h of items) {
    if (h.id === id || !h.pos) continue;
    const hp = h.pos;
    if (cx < hp.xM || cx > hp.xM + hp.wM || cy < hp.yM || cy > hp.yM + hp.dM) continue;
    if (hp.wM * hp.dM <= area) continue;
    return h as T & { pos: ItemPos };
  }
  return null;
}

/** Sets/clears pos.baseM to the host's top height, or back to the floor. */
export function applyStacking<T extends StackableItem>(id: number, pos: ItemPos, items: T[]): ItemPos {
  const host = findHost(id, pos, items);
  if (!host) {
    const { baseM: _drop, ...rest } = pos;
    return rest;
  }
  return { ...pos, baseM: round2((host.pos.baseM ?? 0) + (host.pos.hM ?? 0.8)) };
}
