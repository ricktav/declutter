import { useMemo } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { Box, ChevronRight, MapPin } from "lucide-react";

/** Every room in the current house. Scanned rooms open their floor plan;
 * rooms without a scan yet still list, linking to their items. */
export default function RoomsPage() {
  const { houseId } = useHouse();
  const rooms = trpc.rooms.list.useQuery(undefined, { enabled: houseId != null });
  const data = rooms.data;
  const byFloor = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof data>>();
    for (const r of data ?? []) {
      const k = r.floor ?? "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return [...groups.entries()];
  }, [data]);

  if (houseId == null) return <p className="px-6 py-8 text-sm text-muted-foreground">Add a house to get started.</p>;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Every room in this house. Scanned rooms open a floor plan you can place items on.
      </p>

      <div className="mt-5 space-y-5">
        {rooms.data?.length === 0 && <div className="text-sm text-muted-foreground">No rooms in this house yet.</div>}
        {byFloor.map(([floor, list]) => (
          <div key={floor || "nofloor"} className="space-y-2">
            {byFloor.length > 1 && <div className="micro-label text-muted-foreground">{floor || "no floor"}</div>}
            {list.map((r) => {
              const scanned = r.hasGeometry;
              return (
                <Link
                  key={r.id}
                  to={scanned ? `/rooms/${r.id}` : `/items?roomId=${r.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border bg-white px-4 py-3 hover:bg-accent/40 transition-colors"
                >
                  {scanned ? (
                    <Box className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium truncate">
                      {r.name}
                      {r.floor && <span className="ml-2 rounded bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">{r.floor}</span>}
                    </span>
                    <span className="block text-[12px] text-muted-foreground">
                      {r.itemCount} item{r.itemCount === 1 ? "" : "s"} · {scanned ? "open plan" : "no scan yet"}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
