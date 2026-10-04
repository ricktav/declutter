import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Thumb } from "@/components/Thumb";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { timeAgo } from "@/lib/format";
import { Search, Loader2, MapPin, LayoutGrid, Link2 } from "lucide-react";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { AttachPhotoDialog, type AttachTarget } from "@/components/AttachPhotoDialog";
import { cn } from "@/lib/utils";

type SortBy = "location" | "recent" | "area";
type Photo = {
  source: "photo" | "capture";
  id: number;
  captureId: number | null;
  storageKey: string | null;
  createdAt: Date;
  itemId: number | null;
  itemName: string | null;
  itemStatus: "active" | "archived" | null;
  captureStatus: string | null;
  houseId: number | null;
  roomId: number | null;
  roomName: string | null;
  floor: string | null;
  areaName: string | null;
};
type Placement = { pinCount: number; onPlan: boolean };

/** Where a Thing stands: pinned in a photo, placed on its room's plan. Grey
 * means missing; the title says which. */
function PlacementBadges({ placement }: { placement: Placement }) {
  const pinned = placement.pinCount > 0;
  return (
    <div className="absolute top-3.5 left-3.5 flex gap-1">
      <span
        className={cn(
          "h-6 min-w-6 px-1 flex items-center justify-center gap-0.5 rounded bg-white/85 shadow-sm font-data text-[11px]",
          pinned ? "text-primary" : "text-muted-foreground/50"
        )}
        title={
          pinned
            ? `Pinned in ${placement.pinCount} photo${placement.pinCount === 1 ? "" : "s"}`
            : "Not pinned in any photo"
        }
      >
        <MapPin className="h-3.5 w-3.5" />
        {pinned && placement.pinCount}
      </span>
      <span
        className={cn(
          "h-6 w-6 flex items-center justify-center rounded bg-white/85 shadow-sm",
          placement.onPlan ? "text-primary" : "text-muted-foreground/50"
        )}
        title={placement.onPlan ? "Placed on the plan" : "Not placed on the plan"}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

/** One tile - an item's photo and a location photo both just link straight
 * to where they belong, but a raw inbox capture has no attachment yet, so
 * clicking it has to materialize one first (same step Inbox's own Pin
 * button does) before there's anywhere to navigate to. */
function PhotoTile({
  photo,
  placement,
  onZoom,
  onAttach,
}: {
  photo: Photo;
  placement: Placement | undefined;
  onZoom: (photo: Photo) => void;
  onAttach: (target: AttachTarget) => void;
}) {
  const navigate = useNavigate();
  const ensure = trpc.photos.ensureForCapture.useMutation({
    onSuccess: (res) => navigate(`/annotate/${res.photoId}`),
  });
  // "Pin a Thing…" opens Annotate with the photo's room, so the pin lands there
  const pinQuery = `?roomId=${photo.roomId ?? "none"}`;
  const ensureForPin = trpc.photos.ensureForCapture.useMutation({
    onSuccess: (res) => navigate(`/annotate/${res.photoId}${pinQuery}`),
  });
  const inBucket = photo.itemId == null;

  const caption =
    photo.source === "capture"
      ? photo.captureStatus
      : (photo.itemName ?? (photo.itemId ? "untitled" : "not pinned yet"));

  const inner = (
    <>
      <Thumb storageKey={photo.storageKey} size="lg" />
      <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">{caption}</div>
      <div className="font-data text-[10px] text-muted-foreground">{timeAgo(photo.createdAt)}</div>
      {photo.itemStatus === "archived" && (
        <span className="inline-block text-[10px] font-medium text-muted-foreground bg-muted rounded px-1.5">
          archived
        </span>
      )}
    </>
  );

  const tile =
    photo.source === "capture" ? (
      <button
        className="group w-full rounded-lg border border-border bg-white p-2 text-left hover:border-primary/50 disabled:opacity-60"
        disabled={ensure.isPending}
        onClick={() => ensure.mutate({ captureId: photo.captureId! })}
        title="Pin objects on this photo"
      >
        {ensure.isPending ? (
          <div className="aspect-square w-full flex items-center justify-center rounded-md border border-border bg-muted/40">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Thumb storageKey={photo.storageKey} size="lg" />
        )}
        <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">{caption}</div>
        <div className="font-data text-[10px] text-muted-foreground">{timeAgo(photo.createdAt)}</div>
      </button>
    ) : (
      <Link
        to={photo.itemId ? `/items/${photo.itemId}` : `/annotate/${photo.id}`}
        className="group block rounded-lg border border-border bg-white p-2 hover:border-primary/50"
      >
        {inner}
      </Link>
    );

  // the enlarge button sits beside the link/button, not inside it, so the
  // tile's own click stays exactly as it was and the HTML stays valid
  return (
    <div className="group/tile relative">
      {tile}
      {placement && photo.itemId != null && <PlacementBadges placement={placement} />}
      {inBucket && (
        // visible on hover or keyboard focus; always on touch screens, which cannot hover
        <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover/tile:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button
            type="button"
            className="flex-1 flex items-center justify-center gap-1 rounded border border-border bg-white px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50"
            onClick={() =>
              onAttach(
                photo.source === "capture"
                  ? { source: "capture", captureId: photo.captureId! }
                  : { source: "photo", photoId: photo.id }
              )
            }
            title="Make this one of a Thing's photos"
          >
            <Link2 className="h-3 w-3" /> Attach to Thing…
          </button>
          <button
            type="button"
            className="flex-1 flex items-center justify-center gap-1 rounded border border-border bg-white px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-60"
            disabled={ensureForPin.isPending}
            onClick={() =>
              photo.source === "capture"
                ? ensureForPin.mutate({ captureId: photo.captureId! })
                : navigate(`/annotate/${photo.id}${pinQuery}`)
            }
            title="Draw a box around a Thing on this photo"
          >
            {ensureForPin.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <MapPin className="h-3 w-3" />} Pin
            a Thing…
          </button>
        </div>
      )}
      {photo.storageKey && (
        <button
          type="button"
          onClick={() => onZoom(photo)}
          className="absolute top-3.5 right-3.5 h-6 w-6 flex items-center justify-center rounded bg-white/85 text-[13px] leading-none text-muted-foreground hover:text-foreground shadow-sm"
          title="Enlarge"
          aria-label="Enlarge"
        >
          ⤢
        </button>
      )}
    </div>
  );
}

/** The full-size photo behind a tile, for the zoom overlay. */
function FullImage({ storageKey }: { storageKey: string }) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  if (!url.data?.url) return null;
  return <img src={url.data.url} alt="" draggable={false} className="max-w-full max-h-full object-contain rounded" />;
}

/** Every photo attached to an item, in one catalog - grouped/filtered by
 * location by default, since that's usually how you'd go looking for "the
 * photo of that thing in the living room" rather than by item name. */
export default function PhotosPage() {
  const photos = trpc.photos.listAll.useQuery();
  const houses = trpc.houses.list.useQuery();
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = usePersistedState<SortBy>("photos.sortBy", "location");
  const [showObjects, setShowObjects] = usePersistedState("photos.showObjects", true);
  const [zoomed, setZoomed] = useState<Photo | null>(null);
  const [notPlaced, setNotPlaced] = useState(false);
  const [attachTarget, setAttachTarget] = useState<AttachTarget | null>(null);

  // One placementSummary call for every Thing on the page (never one per
  // tile). The ids come from the whole list, not the filtered one, so typing
  // in the search box does not start a new query each keystroke.
  const itemIds = useMemo(
    () =>
      [...new Set((photos.data ?? []).flatMap((p) => (p.itemId != null ? [p.itemId] : [])))]
        .sort((a, b) => a - b)
        .slice(0, 500), // placementSummary takes at most 500 ids; Things past that get no badge
    [photos.data]
  );
  const summary = trpc.items.placementSummary.useQuery(
    { itemIds },
    // keep the old badges while a new id list loads, so they do not blink after an attach
    { enabled: itemIds.length > 0, placeholderData: keepPreviousData },
  );
  const placementOf = useMemo(
    () => new Map((summary.data ?? []).map((s) => [s.itemId, { pinCount: s.pinCount, onPlan: s.onPlan }])),
    [summary.data]
  );

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (photos.data ?? []).filter((p) => {
      if (notPlaced) {
        // only Things that still lack a pin or a spot on the plan; this shows
        // them even with "Items" off, since that is what the chip asks for
        if (p.itemId == null) return false;
        const pl = placementOf.get(p.itemId);
        if (!pl || (pl.pinCount > 0 && pl.onPlan)) return false;
      } else if (!showObjects && p.itemId != null) return false;
      return (
        !query ||
        (p.itemName ?? "").toLowerCase().includes(query) ||
        (p.roomName ?? "").toLowerCase().includes(query) ||
        (p.floor ?? "").toLowerCase().includes(query) ||
        (p.areaName ?? "").toLowerCase().includes(query)
      );
    });
  }, [photos.data, q, showObjects, notPlaced, placementOf]);

  const groups = useMemo(() => {
    if (sortBy === "recent") {
      const sorted = [...filtered].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return [{ key: "recent", label: "Most recent first", rows: sorted }];
    }
    const houseName = new Map((houses.data ?? []).map((h) => [h.id, h.name]));
    const manyHouses = (houses.data?.length ?? 0) > 1;
    // group by room id, not name: two houses can each have a "Keuken"
    const groupOf = (p: (typeof filtered)[number]): { key: string; label: string } => {
      if (sortBy === "area") return { key: `area:${p.areaName ?? ""}`, label: p.areaName ?? "(no topic)" };
      if (p.roomId == null) return { key: "room:none", label: "(no room)" };
      const name = p.roomName ?? `Room #${p.roomId}`;
      const house = p.houseId != null ? houseName.get(p.houseId) : undefined;
      return { key: `room:${p.roomId}`, label: manyHouses && house ? `${name} · ${house}` : name };
    };
    const map = new Map<string, { key: string; label: string; rows: typeof filtered }>();
    for (const p of filtered) {
      const g = groupOf(p);
      if (!map.has(g.key)) map.set(g.key, { ...g, rows: [] });
      map.get(g.key)!.rows.push(p);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [filtered, sortBy, houses.data]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Photos</h1>
        <span className="font-data text-sm text-muted-foreground">
          {filtered.length} of {photos.data?.length ?? 0}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mt-1">
        Every photo in the system — pinned to an item, confirmed to a location, or still sitting in the inbox.
      </p>

      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            className="w-full rounded-md border border-input bg-white pl-8 pr-3 py-1.5 text-[13px]"
            placeholder="Search item, room, floor, topic…"
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
            <option value="location">Room</option>
            <option value="area">Topic</option>
            <option value="recent">Recently added</option>
          </select>
        </div>
        <label
          className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none"
          title="Toggle off to hide every photo pinned to an item, showing only house/room photos and unprocessed inbox captures"
        >
          <input
            type="checkbox"
            checked={showObjects}
            onChange={(e) => setShowObjects(e.target.checked)}
          />
          Items
          {notPlaced && <span className="text-[11px] italic">(showing unplaced Things)</span>}
        </label>
        <button
          type="button"
          aria-pressed={notPlaced}
          onClick={() => setNotPlaced((v) => !v)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[12px]",
            notPlaced
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-white text-muted-foreground hover:text-foreground"
          )}
          title="Only Things not yet pinned in a photo or not yet placed on their room's plan"
        >
          Not placed
        </button>
      </div>

      <div className="mt-5 space-y-7">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="micro-label text-muted-foreground mb-2 flex items-center gap-2">
              {g.label}
              <span className="font-data text-[11px] opacity-60">{g.rows.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {g.rows.map((p) => (
                <PhotoTile
                  key={`${p.source}-${p.id}`}
                  photo={p}
                  placement={p.itemId != null ? placementOf.get(p.itemId) : undefined}
                  onZoom={setZoomed}
                  onAttach={setAttachTarget}
                />
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            {photos.data?.length === 0
              ? "No photos yet — pin items on photos or add one from an item's page."
              : notPlaced && itemIds.length > 0 && summary.isError
                ? `Could not check placement: ${summary.error.message}`
                : notPlaced && itemIds.length > 0 && !summary.isSuccess
                  ? "Checking placement…"
                  : notPlaced && !q
                    ? "Every Thing with a photo is pinned and on its plan."
                    : `No photos match "${q}".`}
          </div>
        )}
      </div>

      <ZoomOverlay open={!!zoomed?.storageKey} onClose={() => setZoomed(null)} title={zoomed?.itemName ?? undefined}>
        {zoomed?.storageKey && <FullImage storageKey={zoomed.storageKey} />}
      </ZoomOverlay>

      <AttachPhotoDialog target={attachTarget} onClose={() => setAttachTarget(null)} />
    </div>
  );
}
