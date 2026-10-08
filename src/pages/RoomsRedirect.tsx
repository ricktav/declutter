import { Navigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { useLastRoomId } from "@/hooks/use-last-room";

/** /map and /rooms now land on a real Place in the selected house. */
export default function RoomsRedirect() {
  const { houseId } = useHouse();
  const rooms = trpc.rooms.list.useQuery({ houseId });
  const last = useLastRoomId();
  if (rooms.isLoading) return <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>;
  const list = rooms.data ?? [];
  const id = last != null && list.some((r) => r.id === last) ? last : list[0]?.id;
  if (id == null) return <Navigate to="/items" replace />;
  return <Navigate to={`/rooms/${id}`} replace />;
}
