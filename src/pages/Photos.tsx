import { useMemo, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Thumb } from "@/components/Thumb";
import { timeAgo } from "@/lib/format";
import { Search } from "lucide-react";

type SortBy = "location" | "recent" | "area";

/** Every photo attached to an item, in one catalog - grouped/filtered by
 * location by default, since that's usually how you'd go looking for "the
 * photo of that thing in the living room" rather than by item name. */
export default function PhotosPage() {
  const photos = trpc.attachments.listAllImages.useQuery();
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("location");
  const [showObjects, setShowObjects] = useState(true);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (photos.data ?? []).filter((p) => {
      if (!showObjects && p.itemId != null) return false;
      return (
        !query ||
        (p.itemName ?? "").toLowerCase().includes(query) ||
        (p.room ?? "").toLowerCase().includes(query) ||
        (p.floor ?? "").toLowerCase().includes(query) ||
        (p.areaName ?? "").toLowerCase().includes(query)
      );
    });
  }, [photos.data, q, showObjects]);

  const groupOf = (p: (typeof filtered)[number]) => {
    if (sortBy === "area") return p.areaName ?? "(no area)";
    if (sortBy === "location") return [p.floor, p.room].filter(Boolean).join(" · ") || "(no location)";
    return "All photos";
  };

  const groups = useMemo(() => {
    if (sortBy === "recent") {
      const sorted = [...filtered].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return [{ label: "Most recent first", rows: sorted }];
    }
    const map = new Map<string, typeof filtered>();
    for (const p of filtered) {
      const key = groupOf(p);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, rows]) => ({ label, rows }));
  }, [filtered, sortBy]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Photos</h1>
        <span className="font-data text-sm text-muted-foreground">
          {filtered.length} of {photos.data?.length ?? 0}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mt-1">
        Every photo attached to an item, in one place.
      </p>

      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            className="w-full rounded-md border border-input bg-white pl-8 pr-3 py-1.5 text-[13px]"
            placeholder="Search item, room, floor, area…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          group by
          <select
            className="rounded-md border border-input bg-white px-2 py-1.5 text-[12px]"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
          >
            <option value="location">Location (floor · room)</option>
            <option value="area">Area (topic)</option>
            <option value="recent">Recently added</option>
          </select>
        </div>
        <label
          className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none"
          title="Toggle off to hide item cutout photos, showing only full location photos"
        >
          <input
            type="checkbox"
            checked={showObjects}
            onChange={(e) => setShowObjects(e.target.checked)}
          />
          Objects
        </label>
      </div>

      <div className="mt-5 space-y-7">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="micro-label text-muted-foreground mb-2 flex items-center gap-2">
              {g.label}
              <span className="font-data text-[11px] opacity-60">{g.rows.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {g.rows.map((p) => (
                <Link
                  key={p.id}
                  to={p.itemId ? `/items/${p.itemId}` : `/annotate/${p.id}`}
                  className="group rounded-lg border border-border bg-white p-2 hover:border-primary/50"
                >
                  <Thumb storageKey={p.storageKey} size="lg" />
                  <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">
                    {p.itemName ?? (p.itemId ? "untitled" : "not pinned yet")}
                  </div>
                  <div className="font-data text-[10px] text-muted-foreground">{timeAgo(p.createdAt)}</div>
                  {p.itemStatus === "archived" && (
                    <span className="inline-block text-[10px] font-medium text-muted-foreground bg-muted rounded px-1.5">
                      archived
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            {photos.data?.length === 0 ? "No photos yet — pin items on photos or add one from an item's page." : `No photos match "${q}".`}
          </div>
        )}
      </div>
    </div>
  );
}
