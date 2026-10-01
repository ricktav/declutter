import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Home, MapPin, ChevronRight, Loader2 } from "lucide-react";

type Location = {
  houseId: number | null;
  houseName: string | null;
  floor: string | null;
  room: string;
  count: number;
};

const locationKey = (l: Pick<Location, "houseId" | "floor" | "room">) => `${l.houseId ?? 0}|${l.floor ?? ""}|${l.room}`;

// sessionStorage, not localStorage - "keep last used during the session"
// means forgetting it again once the tab/browser closes, not forever
const SESSION_KEY = "declutter.map.lastLocation";

/**
 * Location-first entry point onto the same SSOT the item workbench uses.
 * Pick a place, not a thing: see the photo(s) for that room, pin objects
 * on them (same canvas as /annotate — just reached from a place instead
 * of a specific attachment).
 */
export default function MapPage() {
  const locations = trpc.map.listLocations.useQuery();
  const [selected, setSelected] = useState<Location | null>(null);

  useEffect(() => {
    if (selected || !locations.data || locations.data.length === 0) return;
    const lastKey = sessionStorage.getItem(SESSION_KEY);
    const match = lastKey ? locations.data.find((l) => locationKey(l) === lastKey) : null;
    setSelected(match ?? locations.data[0]);
  }, [locations.data, selected]);

  const selectLocation = (l: Location) => {
    setSelected(l);
    try {
      sessionStorage.setItem(SESSION_KEY, locationKey(l));
    } catch {
      // storage unavailable - selection still works for this render
    }
  };

  const photos = trpc.map.photosForLocation.useQuery(
    { houseId: selected?.houseId ?? null, floor: selected?.floor ?? null, room: selected?.room ?? "" },
    { enabled: !!selected },
  );

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Pick a place to see what's pinned there — a spatial index on top of the same items, not a separate inventory.
      </p>

      <div className="flex gap-6 mt-6 items-start">
        <aside className="w-64 shrink-0 rounded-lg border border-border bg-white p-2 space-y-0.5">
          <div className="micro-label text-muted-foreground px-2 py-1.5">Locations</div>
          {locations.isLoading && <div className="px-2 py-2 text-[13px] text-muted-foreground">Loading…</div>}
          {locations.data?.length === 0 && (
            <div className="px-2 py-2 text-[13px] text-muted-foreground">
              No items have a room set yet.
            </div>
          )}
          {locations.data?.map((l) => {
            const key = locationKey(l);
            const isSelected = selected && locationKey(selected) === key;
            return (
              <button
                key={key}
                onClick={() => selectLocation(l)}
                className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] ${
                  isSelected ? "bg-muted" : "hover:bg-muted/50"
                }`}
              >
                <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate font-medium">{l.room}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[l.houseName, l.floor].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
                <span className="font-data text-[11px] text-muted-foreground">{l.count}</span>
              </button>
            );
          })}
        </aside>

        <div className="flex-1 min-w-0">
          {!selected ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-16 text-center text-[13px] text-muted-foreground">
              <Home className="h-6 w-6 mx-auto mb-2 opacity-50" />
              Pick a location on the left to see its photos and pins.
            </div>
          ) : photos.isLoading ? (
            <div className="text-[13px] text-muted-foreground px-2">Loading photos…</div>
          ) : !photos.data?.length ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-16 text-center text-[13px] text-muted-foreground">
              No source photos found for <b>{selected.room}</b> yet — the pool fills in automatically as items
              from this room get detected via the inbox.
            </div>
          ) : (
            <>
              <div className="micro-label text-muted-foreground mb-2">
                {selected.room} — {photos.data.length} photo{photos.data.length === 1 ? "" : "s"}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {photos.data.map((p) => (
                  <PhotoCard key={p.id} storageKey={p.storageKey} captureId={p.id} houseId={selected.houseId} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One photo in the pool. The pool is keyed by *capture* id (the original
 * source photo), but the pin canvas at /annotate works on an *attachment*
 * id - a capture isn't pinnable until it's also an attachment. Materialize
 * one on demand (find-or-create, so repeat visits reuse the same row)
 * before navigating in.
 */
function PhotoCard({ storageKey, captureId, houseId }: { storageKey: string; captureId: number; houseId: number | null }) {
  const url = trpc.attachments.url.useQuery({ key: storageKey });
  const navigate = useNavigate();
  const ensure = trpc.map.ensureAttachmentForCapture.useMutation({
    onSuccess: (res) => navigate(`/annotate/${res.attachmentId}`),
  });

  return (
    <div className="rounded-lg border border-border bg-white p-2">
      {url.data?.url ? (
        <img src={url.data.url} alt="" className="w-full aspect-video object-cover rounded" />
      ) : (
        <div className="w-full aspect-video rounded bg-muted/40" />
      )}
      <button
        onClick={() => ensure.mutate({ captureId, houseId })}
        disabled={ensure.isPending}
        className="mt-1.5 flex items-center gap-1 text-[12px] text-primary hover:underline disabled:opacity-50"
      >
        {ensure.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>Pin objects on this photo <ChevronRight className="h-3 w-3" /></>
        )}
      </button>
    </div>
  );
}
