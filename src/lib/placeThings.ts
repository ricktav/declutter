// src/lib/placeThings.ts
// Annotate's "Place a Thing" rows: the Photo's room's Things, each with
// whether it is pinned on this Photo, on another Photo, or nowhere yet, and
// which existing pin a tap should move instead of adding a second one.
import { useMemo } from "react";
import { derivedType, TYPE_LABELS } from "@db/taxonomy";
import { trpc } from "@/providers/trpc";

export type PlaceState = "here" | "elsewhere" | "none";

/** The pin fields Place a Thing reads from a Photo's pins (dismissed ones included). */
export type PlacePin = {
  id: number;
  itemId: number | null;
  status: "suggested" | "confirmed" | "dismissed";
  flagged: boolean;
  wPct: number | null;
  hPct: number | null;
};

export type PlaceRow = {
  id: number;
  name: string;
  chip: string | null;
  state: PlaceState;
  /** this Thing's confirmed pin on this Photo, when it has one */
  pinHere: PlacePin | null;
  /** the child room a rolled-up Thing sits in; null when in the Photo's room */
  roomName: string | null;
};

const STATE_ORDER: Record<PlaceState, number> = { none: 0, elsewhere: 1, here: 2 };

/** The pin a tap for this Thing should move instead of adding a second one:
 * confirmed first, then an AI suggestion, then a dismissed pin (restored). */
export function existingPinFor<P extends PlacePin>(pins: P[], itemId: number): P | null {
  const mine = pins.filter((p) => p.itemId === itemId);
  return (
    mine.find((p) => p.status === "confirmed") ??
    mine.find((p) => p.status === "suggested") ??
    mine.find((p) => p.status === "dismissed") ??
    null
  );
}

/** The Thing after `currentId` (wrapping) that is not pinned on this Photo
 * yet; from the first row when `currentId` is not in the list. */
export function nextUnplaced(rows: PlaceRow[], currentId: number): PlaceRow | null {
  const i = rows.findIndex((r) => r.id === currentId);
  for (let k = 0; k < rows.length; k++) {
    const r = rows[(i + 1 + k) % rows.length];
    if (r.id !== currentId && r.state !== "here") return r;
  }
  return null;
}

function chipFor(attrs: Record<string, unknown>): string | null {
  const t = derivedType(attrs);
  if (t) return Object.hasOwn(TYPE_LABELS, t) ? TYPE_LABELS[t] : t;
  return typeof attrs.role === "string" && attrs.role.trim() ? attrs.role.trim() : null;
}

/**
 * Rows for the room's active, not-rejected Things (incl. rolled-up child
 * rooms), sorted not pinned → pinned elsewhere → pinned here, then by name.
 * "Elsewhere" comes from one pins.listForRoom for the room; only Things not
 * pinned anywhere in the room are looked up with pins.listForItem (batched).
 */
export function usePlaceThings({
  roomId,
  photoId,
  pins,
}: {
  roomId: number | null;
  photoId: number;
  pins: PlacePin[];
}) {
  const room = trpc.rooms.get.useQuery({ id: roomId ?? -1 }, { enabled: roomId != null });
  const roomPins = trpc.pins.listForRoom.useQuery({ roomId: roomId ?? -1 }, { enabled: roomId != null });

  const things = useMemo(
    () =>
      (room.data?.items ?? []).filter((it) => it.status === "active" && it.verificationStatus !== "rejected"),
    [room.data],
  );
  const hereByItem = new Map<number, PlacePin>();
  for (const p of pins) if (p.status === "confirmed" && p.itemId != null && !hereByItem.has(p.itemId)) hereByItem.set(p.itemId, p);
  const elsewhereInRoom = new Set(
    (roomPins.data ?? [])
      .filter((p) => p.status === "confirmed" && p.photoId !== photoId && p.itemId != null)
      .map((p) => p.itemId as number),
  );
  const lookupIds = roomPins.isSuccess
    ? things.filter((t) => !hereByItem.has(t.id) && !elsewhereInRoom.has(t.id)).map((t) => t.id)
    : [];
  const lookups = trpc.useQueries((t) => lookupIds.map((itemId) => t.pins.listForItem({ itemId })));
  const elsewhereByLookup = new Set<number>();
  lookupIds.forEach((itemId, i) => {
    const data = lookups[i]?.data;
    if (data?.some((p) => p.status === "confirmed" && p.photoId !== photoId)) elsewhereByLookup.add(itemId);
  });

  const rows: PlaceRow[] = things
    .map((t) => {
      const pinHere = hereByItem.get(t.id) ?? null;
      const state: PlaceState = pinHere
        ? "here"
        : elsewhereInRoom.has(t.id) || elsewhereByLookup.has(t.id)
          ? "elsewhere"
          : "none";
      return {
        id: t.id,
        name: t.name,
        roomName: t.ownerRoomId !== roomId ? t.ownerRoomName : null,
        chip: chipFor((t.attributes ?? {}) as Record<string, unknown>),
        state,
        pinHere,
      };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name) || a.id - b.id);

  return { rows, loading: room.isLoading && roomId != null };
}
