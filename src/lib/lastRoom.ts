// src/lib/lastRoom.ts
const KEY = "declutter.lastRoomId";

/** The room you last filed something into: the default for the next "where?" */
export function getLastRoomId(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setLastRoomId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(id));
  } catch {
    // storage unavailable
  }
}
