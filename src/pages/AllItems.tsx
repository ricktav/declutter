import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Thumb } from "@/components/Thumb";
import { timeAgo } from "@/lib/format";
import { Archive, LayoutGrid, List as ListIcon, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/hooks/use-persisted-state";

type SortBy = "area" | "location" | "updated";

export default function AllItems() {
  const [searchParams, setSearchParams] = useSearchParams();
  const roomIdParam = searchParams.get("roomId");
  const roomFilter = roomIdParam && roomIdParam !== "none" && Number.isFinite(Number(roomIdParam)) ? Number(roomIdParam) : null;
  const clearRoom = () => { const next = new URLSearchParams(searchParams); next.delete("roomId"); setSearchParams(next, { replace: true }); };
  const items = trpc.items.listAll.useQuery({ includeArchived: false, roomId: roomFilter ?? undefined, ...(roomFilter != null ? { houseId: null } : {}) });
  const roomsQuery = trpc.rooms.list.useQuery({ houseId: null }, { enabled: roomFilter != null });
  const filterRoom = roomFilter != null ? roomsQuery.data?.find((r) => r.id === roomFilter) : undefined;
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = usePersistedState<SortBy>("allItems.sortBy", "area");
  const [view, setView] = usePersistedState<"list" | "gallery">("allItems.view", "list");

  const locationFilterActive = roomFilter != null;

  useEffect(() => {
    if (locationFilterActive) setSortBy("location");
  }, [locationFilterActive]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (locationFilterActive) return items.data ?? [];
    return (items.data ?? []).filter(
      (i) =>
        !query ||
        i.name.toLowerCase().includes(query) ||
        (i.room?.name ?? "").toLowerCase().includes(query) ||
        (i.room?.floor ?? "").toLowerCase().includes(query) ||
        (i.areaName ?? "").toLowerCase().includes(query),
    );
  }, [items.data, q, locationFilterActive]);

  // group key + label (+ floor sub-label for rooms) depending on sort mode
  const groupOf = (i: (typeof filtered)[number]): { key: string; label: string; sub?: string } => {
    if (sortBy === "area") {
      const l = i.areaName ?? "(no topic)";
      return { key: l, label: l };
    }
    if (sortBy === "location") {
      return i.room
        ? { key: `room:${i.room.id}`, label: i.room.name, sub: i.room.floor ?? undefined }
        : { key: "none", label: "(no room)" };
    }
    return { key: "all", label: "All items" };
  };

  const groups = useMemo(() => {
    const sorted = [...filtered];
    if (sortBy === "updated") {
      sorted.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
      return [{ key: "all", label: "All items, most recently updated first", sub: undefined as string | undefined, rows: sorted }];
    }
    const map = new Map<string, { key: string; label: string; sub?: string; rows: typeof filtered }>();
    for (const i of sorted) {
      const g = groupOf(i);
      if (!map.has(g.key)) map.set(g.key, { ...g, rows: [] });
      map.get(g.key)!.rows.push(i);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label) || (a.sub ?? "").localeCompare(b.sub ?? ""));
  }, [filtered, sortBy]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">All items</h1>
        <span className="font-data text-sm text-muted-foreground">
          {filtered.length} of {items.data?.length ?? 0}
        </span>
      </div>

      {locationFilterActive && (
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[12px]">
          <span className="text-muted-foreground">room:</span>
          <span className="font-medium">{filterRoom?.name ?? `#${roomFilter}`}</span>
          {filterRoom?.floor && <span className="text-[11px] text-muted-foreground">{filterRoom.floor}</span>}
          <button onClick={clearRoom} className="text-muted-foreground hover:text-foreground ml-1">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            className="w-full rounded-md border border-input bg-white pl-8 pr-3 py-1.5 text-[13px]"
            placeholder="Search name, room, floor, topic…"
            value={q}
            disabled={locationFilterActive}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          sort by
          <select
            className="rounded-md border border-input bg-white px-2 py-1.5 text-[12px]"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
          >
            <option value="area">Topic</option>
            <option value="location">Room</option>
            <option value="updated">Recently updated</option>
          </select>
        </div>
        <div className="ml-auto flex gap-1 rounded-md border border-border p-0.5">
          <button
            className={cn("rounded p-1", view === "list" ? "bg-muted" : "text-muted-foreground")}
            onClick={() => setView("list")}
            title="List"
          >
            <ListIcon className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn("rounded p-1", view === "gallery" ? "bg-muted" : "text-muted-foreground")}
            onClick={() => setView("gallery")}
            title="Gallery"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-5 space-y-7">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="micro-label text-muted-foreground mb-2 flex items-center gap-2">
              {g.label}
              {g.sub && <span className="normal-case tracking-normal text-[11px] opacity-80">{g.sub}</span>}
              <span className="font-data text-[11px] opacity-60">{g.rows.length}</span>
            </div>
            {view === "gallery" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {g.rows.map((it) => (
                  <Link
                    key={it.id}
                    to={`/items/${it.id}`}
                    className="group rounded-lg border border-border bg-white p-2 hover:border-primary/50"
                  >
                    <Thumb storageKey={it.imageKey} size="lg" />
                    <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">{it.name}</div>
                    {it.verificationStatus === "detected" && (
                      <span className="inline-block text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5">
                        needs review
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-white overflow-x-auto">
                <table className="ledger-table w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="w-12" />
                      <th>Name</th>
                      {sortBy !== "area" && <th>Topic</th>}
                      {sortBy !== "location" && <th>Location</th>}
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((it) => (
                      <tr key={it.id} className={it.status === "archived" ? "opacity-50" : ""}>
                        <td>
                          <Thumb storageKey={it.imageKey} />
                        </td>
                        <td>
                          <Link to={`/items/${it.id}`} className="font-medium text-primary hover:underline">
                            {it.name}
                          </Link>
                          {it.verificationStatus === "detected" && (
                            <span className="ml-1.5 inline-block text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5">
                              needs review
                            </span>
                          )}
                          {it.status === "archived" && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                              <Archive className="h-3 w-3" /> archived
                            </span>
                          )}
                        </td>
                        {sortBy !== "area" && (
                          <td className="text-[12px]">
                            {it.areaSlug ? (
                              <Link to={`/areas/${it.areaSlug}`} className="text-muted-foreground hover:text-primary hover:underline">
                                {it.areaName}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        )}
                        {sortBy !== "location" && (
                          <td className="text-[12px] text-muted-foreground">
                            {it.room?.name ?? "—"}
                            {it.room?.floor && (
                              <span className="ml-1.5 rounded bg-muted px-1.5 text-[10px]">{it.room.floor}</span>
                            )}
                          </td>
                        )}
                        <td className="font-data text-[11px] text-muted-foreground">{timeAgo(it.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            {locationFilterActive ? `No items are placed in ${filterRoom ? `"${filterRoom.name}"` : "this room"} yet.` : `No items match "${q}".`}
          </div>
        )}
      </div>
    </div>
  );
}
