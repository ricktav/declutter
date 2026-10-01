import type { RoomValue } from "@/components/RoomPicker";

const KEY = "declutter.lastLocation";

/** Remembers the last house/floor/room confirmed while pinning, so the next
 * "where was this taken?" prompt starts from wherever you're actually
 * working instead of blank every time - most sessions happen in one place. */
export function getLastLocation(): RoomValue {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { houseId: null, floor: "", room: "" };
    const v = JSON.parse(raw);
    return {
      houseId: typeof v.houseId === "number" ? v.houseId : null,
      floor: typeof v.floor === "string" ? v.floor : "",
      room: typeof v.room === "string" ? v.room : "",
    };
  } catch {
    return { houseId: null, floor: "", room: "" };
  }
}

export function setLastLocation(loc: RoomValue) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loc));
  } catch {
    // private browsing / storage disabled - just won't remember next time
  }
}
