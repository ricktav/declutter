import { trpc } from "@/providers/trpc";
import { getLastRoomId } from "@/lib/lastRoom";

/** The last-used room, only if it still exists in the session house; else null. */
export function useLastRoomId(): number | null {
  const rooms = trpc.rooms.list.useQuery();
  const last = getLastRoomId();
  if (last == null || !rooms.data) return null;
  return rooms.data.some((r) => r.id === last) ? last : null;
}
