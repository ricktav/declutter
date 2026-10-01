import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Thumb } from "@/components/Thumb";
import { timeAgo } from "@/lib/format";
import { Archive, LayoutGrid, List as ListIcon, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/hooks/use-persisted-state";

type SortBy = "area" | "location" | "updated";

// "none" is a sentinel the sidebar's Locations links use for a null
// houseId/floor, since that's how map.listLocations groups them - distinct
// from the param being absent entirely (which means "don't filter on this").
function paramMatches(value: string | null, itemValue: string | number | null): boolean {
  if (value == null) return true;
  if (value === "none") return itemValue == null || itemValue === "";
  return String(itemValue ?? "") === value;
}

export default function AllItems() {
  const items = trpc.items.listAll.useQuery({ includeArchived: false });
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = usePersistedState<SortBy>("allItems.sortBy", "area");
  const [view, setView] = usePersistedState<"list" | "gallery">("allItems.view", "list");
  const [searchParams, setSearchParams] = useSearchParams();

  const locHouseId = searchParams.get("houseId");
  const locFloor = searchParams.get("floor");
  const locRoom = searchParams.get("room");
  const locationFilterActive = locRoom != null;

  useEffect(() => {
    if (locationFilterActive) setSortBy("location");
  }, [locationFilterActive]);

  const clearLocationFilter = () => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete("houseId");
    next.delete("floor");
    next.delete("room");
    return next;
  });

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const rows = (items.data ?? []).filter((i) => {
      if (locationFilterActive) {
        return (
          i.room === locRoom && paramMatches(locFloor, i.floor) && paramMatches(locHouseId, i.houseId)
        );
      }
      return (
        !query ||
        i.name.toLowerCase().includes(query) ||
        (i.room ?? "").toLowerCase().includes(query) ||
        (i.floor ?? "").toLowerCase().includes(query) ||
        (i.areaName ?? "").toLowerCase().includes(query)
      );
    });
    return rows;
  }, [items.data, q, locationFilterActive, locRoom, locFloor, locHouseId]);

  // group key + label depending on sort mode
  const groupOf = (i: (typeof filtered)[number]) => {
    if (sortBy === "area") return i.areaName ?? "(no topic)";
    if (sortBy === "location") {
      const loc = [i.floor, i.room].filter(Boolean).join(" · ");
      return loc || "(no location)";
    }
    return "All items";
  };

  const groups = useMemo(() => {
    const sorted = [...filtered];
    if (sortBy === "updated") {
      sorted.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
      return [{ label: "All items, most recently updated first", rows: sorted }];
    }
    const map = new Map<string, typeof filtered>();
    for (const i of sorted) {
      const key = groupOf(i);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, rows]) => ({ label, rows }));
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
          <span className="text-muted-foreground">location:</span>
          <span className="font-medium">{locRoom}</span>
          <button onClick={clearLocationFilter} className="text-muted-foreground hover:text-foreground ml-1">
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
            <option value="location">Location (floor · room)</option>
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
          <div key={g.label}>
            <div className="micro-label text-muted-foreground mb-2 flex items-center gap-2">
              {g.label}
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
                            {[it.floor, it.room].filter(Boolean).join(" · ") || "—"}
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
            {locationFilterActive ? `No items are placed in "${locRoom}" yet.` : `No items match "${q}".`}
          </div>
        )}
      </div>
    </div>
  );
}
