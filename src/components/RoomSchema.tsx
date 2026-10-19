import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Flag } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { DECISIONS } from "@/lib/decisions";
import { PhotoSchematic } from "@/components/PhotoSchematic";
import { SchemaFilters } from "@/components/SchemaFilters";
import { ThingModal } from "@/components/ThingModal";
import {
  hasFilterParams,
  isEmptyFilter,
  loadStoredSchemaFilter,
  parseSchemaFilter,
  pinTitle,
  pinTypeLabel,
  storeSchemaFilter,
  visibleSchemaPins,
  withSchemaFilter,
  type SchemaFilter,
  type SchemaPin,
} from "@/lib/schemaFilter";

/** width / height per storageKey, so a Photo's schematic keeps its shape across renders and rooms. */
const photoAspects = new Map<string, number>();

/**
 * The room page's Schema view: per Photo of the room (and its rolled-up child
 * rooms) the Photo next to a schematic of its framed Things, filtered
 * client-side. One `pins.listForRoom` call per room; the filter lives in the
 * URL and is mirrored to localStorage.
 */
export function RoomSchema({ roomId }: { roomId: number }) {
  const pins = trpc.pins.listForRoom.useQuery({ roomId }, { enabled: roomId > 0 });
  const areas = trpc.areas.list.useQuery({ houseId: null });
  const [params, setParams] = useSearchParams();
  const filter = parseSchemaFilter(params);
  const showPoints = params.get("points") === "1";
  const [picked, setPicked] = useState<SchemaPin | null>(null);

  // A bare `?schema=1` (a link, the switch) takes the remembered filter.
  useEffect(() => {
    if (hasFilterParams(params)) return;
    const stored = loadStoredSchemaFilter();
    if (stored && !isEmptyFilter(stored)) setParams((prev) => withSchemaFilter(prev, stored), { replace: true });
    // once per mount: later changes go through setFilter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A filter that arrives by URL (a shared link, back/forward) becomes the remembered one too.
  const urlFilter = hasFilterParams(params) ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (urlFilter) storeSchemaFilter(JSON.parse(urlFilter) as SchemaFilter);
  }, [urlFilter]);

  const setFilter = (f: SchemaFilter) => {
    storeSchemaFilter(f);
    setParams((prev) => withSchemaFilter(prev, f), { replace: true });
  };
  const setShowPoints = (on: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set("points", "1");
        else next.delete("points");
        return next;
      },
      { replace: true },
    );

  const groups = useMemo(() => {
    const out: Array<{ photoId: number; title: string | null; storageKey: string; pins: SchemaPin[] }> = [];
    const byId = new Map<number, (typeof out)[number]>();
    for (const p of pins.data ?? []) {
      let g = byId.get(p.photoId);
      if (!g) {
        g = { photoId: p.photoId, title: p.photoTitle, storageKey: p.photoStorageKey, pins: [] };
        byId.set(p.photoId, g);
        out.push(g);
      }
      g.pins.push(p);
    }
    return out;
  }, [pins.data]);

  const topics = useMemo(
    () => (areas.data ?? []).map((a) => ({ id: a.id, name: a.name, color: a.color })),
    [areas.data],
  );

  if (pins.isLoading) return <div className="text-[13px] text-muted-foreground">Loading schema…</div>;
  if (pins.error) return <div className="text-[13px] text-destructive">Could not load the pins: {pins.error.message}</div>;

  const all = pins.data ?? [];
  const shown = groups.reduce((n, g) => n + visibleSchemaPins(g.pins, filter, showPoints).length, 0);

  return (
    <div data-testid="room-schema">
      <SchemaFilters filter={filter} onChange={setFilter} pins={all} topics={topics} />
      <div className="mb-2 flex items-center justify-between text-[12px] text-muted-foreground">
        <span data-testid="schema-count">
          {shown} of {all.length} pins shown
        </span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" data-testid="show-points" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
          Show points
        </label>
      </div>
      {!groups.length ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
          No pinned Things in this Place&apos;s Photos yet — pin them in Annotate.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <SchemaPhotoCard
              key={g.photoId}
              title={g.title}
              photoId={g.photoId}
              storageKey={g.storageKey}
              pins={g.pins}
              filter={filter}
              showPoints={showPoints}
              selectedItemId={picked?.itemId ?? null}
              onPick={setPicked}
            />
          ))}
        </div>
      )}
      <ThingModal pin={picked} onClose={() => setPicked(null)} />
    </div>
  );
}

function SchemaPhotoCard({
  title,
  photoId,
  storageKey,
  pins,
  filter,
  showPoints,
  selectedItemId,
  onPick,
}: {
  title: string | null;
  photoId: number;
  storageKey: string;
  pins: SchemaPin[];
  filter: SchemaFilter;
  showPoints: boolean;
  selectedItemId: number | null;
  onPick: (p: SchemaPin) => void;
}) {
  const url = trpc.photos.url.useQuery({ key: storageKey });
  const [aspect, setAspect] = useState<number | null>(() => photoAspects.get(storageKey) ?? null);
  const visible = visibleSchemaPins(pins, filter, showPoints);

  return (
    <section className="rounded-lg border border-border p-2" data-photo-id={photoId}>
      <div className="mb-1.5 truncate text-[12px] font-medium">{title || `Photo #${photoId}`}</div>
      <div className="grid grid-cols-2 gap-2 items-start">
        <div className="overflow-hidden rounded bg-muted" style={aspect ? { aspectRatio: String(aspect) } : undefined}>
          {url.data?.url && (
            <img
              src={url.data.url}
              alt=""
              className="block h-full w-full"
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w > 0 && h > 0) {
                  photoAspects.set(storageKey, w / h);
                  setAspect(w / h);
                }
              }}
            />
          )}
        </div>
        {aspect != null ? (
          <PhotoSchematic
            pins={pins}
            aspect={aspect}
            filter={filter}
            showPoints={showPoints}
            selectedItemId={selectedItemId}
            onPick={onPick}
          />
        ) : (
          <div className="aspect-[4/3] w-full rounded border border-dashed border-border" />
        )}
      </div>
      {visible.length > 0 ? (
        <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="schema-cards">
          {visible.map((p) => (
            <li key={p.id}>
              <SchemaPinCard pin={p} onPick={onPick} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">No pins match the filter on this Photo.</p>
      )}
    </section>
  );
}

function SchemaPinCard({ pin, onPick }: { pin: SchemaPin; onPick: (p: SchemaPin) => void }) {
  const item = pin.item;
  const typeLabel = pinTypeLabel(pin);
  const decision = item?.decision ? DECISIONS.find((d) => d.key === item.decision) : null;
  const attrs = (item?.attributes ?? {}) as Record<string, string | number | undefined>;
  const detail = [attrs.hostname, attrs.ip, attrs.os].filter((v) => v != null && v !== "").join(" · ");
  return (
    <button
      type="button"
      data-card-pin-id={pin.id}
      onClick={() => onPick(pin)}
      className="flex w-full items-start gap-2 rounded border border-border bg-background px-2 py-1.5 text-left hover:bg-muted"
      style={{ borderLeft: `3px ${pin.status === "suggested" ? "dashed" : "solid"} ${pin.itemAreaColor ?? "#8A8F86"}` }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-[12px] font-medium">
          <span className="truncate">{pinTitle(pin)}</span>
          {pin.flagged && <Flag className="h-3 w-3 shrink-0 text-amber-600" />}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {[typeLabel, item?.tags.join(", ")].filter(Boolean).join(" · ") || (item ? "No Type yet" : "No Thing")}
        </span>
        {detail && <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>}
      </span>
      {decision && (
        <span className="shrink-0 text-[11px]" style={{ color: decision.color }}>
          {decision.label}
        </span>
      )}
    </button>
  );
}
