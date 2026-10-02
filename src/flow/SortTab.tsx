import { useState, type ReactNode } from "react";
import { Loader2, MapPin, Sparkles, Plus, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { GeojsonThumb } from "@/components/GeojsonThumb";
import { ItemRoomPreview } from "@/components/ItemRoomPreview";
import { useFlow } from "./context";
import { LocationSheet } from "./LocationSheet";
import { EmptyState, ErrorLine, Photo } from "./ui";
import { BackupPicker, LabFields } from "./LabParts";
import { filterOf, useSortCards, type Filter } from "./queue";
import { getSnapPlace, isGeojsonKey, placeLabel, usableSuggestion, type FlowCapture, type FlowItem, type Place } from "./data";
import { LAB, LAB_KEYS, role, roleLabel } from "./lenses";

/** Finish the record, one card at a time: what is it, is it right, where is it. */
export function SortTab() {
  const { lens, ready } = useFlow();
  const [filter, setFilter] = useState<Filter>("all");
  const [skipped, setSkipped] = useState<string[]>([]);
  const cards = useSortCards();

  const counts: Record<Filter, number> = { all: cards.length, capture: 0, check: 0, lab: 0, place: 0 };
  for (const c of cards) counts[filterOf(c)]++;
  const visible = cards.filter((x) => filter === "all" || filterOf(x) === filter);
  // skipped cards go to the back of the line instead of disappearing
  const ordered = [...visible.filter((x) => !skipped.includes(x.key)), ...visible.filter((x) => skipped.includes(x.key))];
  const card = ordered[0];

  const skip = () => card && setSkipped((s) => [...s.filter((k) => k !== card.key), card.key]);

  if (!ready) return <p className="py-10 text-center text-[13px] text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-1 px-1">
        {(
          [
            ["all", "All"],
            ["capture", "Photos"],
            ["check", "Check"],
            ...(lens === "lab" ? ([["lab", "Lab"]] as const) : []),
            ["place", "Place"],
          ] as const
        ).map(([f, label]) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-[13px]",
              filter === f ? "border-transparent bg-[#282c20] text-[#f4f4ed]" : "border-border bg-white",
            )}
          >
            {label} <span className="font-data opacity-70">{counts[f]}</span>
          </button>
        ))}
      </div>

      {!card ? (
        <EmptyState title="Nothing to sort">
          {lens === "lab"
            ? "Every lab thing has its role, its backup and its place."
            : "Everything is named, checked and placed. Snap more things, or go to Act to decide what stays."}
        </EmptyState>
      ) : (
        <>
          {card.kind === "capture" && <CaptureCard key={card.key} capture={card.capture} onSkip={skip} />}
          {card.kind === "check" && <CheckCard key={card.key} item={card.item} onSkip={skip} />}
          {card.kind === "lab" && <LabDetailsCard key={card.key} item={card.item} onSkip={skip} />}
          {card.kind === "backup" && <BackupCard key={card.key} item={card.item} onSkip={skip} />}
          {card.kind === "place" && <PlaceCard key={card.key} item={card.item} onSkip={skip} />}
          <p className="text-center font-data text-[12px] text-muted-foreground">{ordered.length} left in this list</p>
        </>
      )}
    </div>
  );
}

function CardShell({ question, children, onSkip }: { question: string; children: ReactNode; onSkip: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between px-1">
        <span className="font-data text-[16px] font-bold">{question}</span>
        <button onClick={onSkip} className="font-data text-[12px] text-muted-foreground underline">
          skip
        </button>
      </div>
      {children}
    </div>
  );
}

type Row = { name: string; areaId: number | null; checked: boolean; attributes?: Record<string, string> };

function CaptureCard({ capture, onSkip }: { capture: FlowCapture; onSkip: () => void }) {
  const { areas, here, locations, lens, refresh } = useFlow();
  const suggestion = usableSuggestion(capture);
  const defaultAreaId = (lens === "lab" ? areas.find((a) => a.slug === LAB.defaultAreaSlug)?.id : undefined) ?? areas[0]?.id ?? null;
  const matched = suggestion?.items.filter((s) => !s.isNewItem && s.matchedItemName) ?? [];

  const initialRows = (): Row[] =>
    (suggestion?.items ?? [])
      .filter((s) => s.isNewItem || !s.matchedItemName)
      .map((s) => ({
        name: s.itemName,
        areaId: areas.find((a) => a.slug === s.areaSlug)?.id ?? defaultAreaId,
        checked: true,
        attributes: s.attributes,
      }));
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [extra, setExtra] = useState("");
  const [place, setPlace] = useState<Place>(() => {
    const snapped = getSnapPlace(capture.id);
    if (snapped) return snapped;
    if (suggestion?.roomId != null) return { roomId: suggestion.roomId };
    return here;
  });
  // the room must belong to the current house (a snapped place may predate a house switch)
  const validPlace: Place = place.roomId != null && locations.some((l) => l.id === place.roomId) ? place : { roomId: null };
  const [placeOpen, setPlaceOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI finished in the background: show its rows (but never clobber edits)
  const [seenSuggestion, setSeenSuggestion] = useState(capture.suggestion);
  if (capture.suggestion !== seenSuggestion) {
    setSeenSuggestion(capture.suggestion);
    if (suggestion && rows.length === 0) setRows(initialRows());
  }

  const triage = trpc.inbox.triage.useMutation({
    onSuccess: (res) => (res.ok ? refresh() : setError(res.error)),
    onError: (e) => setError(e.message),
  });
  const accept = trpc.inbox.acceptMany.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });
  const dismiss = trpc.inbox.dismiss.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });

  const chosen = rows.filter((r) => r.checked && r.name.trim() && r.areaId != null);
  const busy = accept.isPending || dismiss.isPending;

  const addExtra = () => {
    const n = extra.trim();
    if (!n) return;
    setRows((r) => [...r, { name: n, areaId: defaultAreaId, checked: true }]);
    setExtra("");
  };

  const isGeo = isGeojsonKey(capture.storageKey) || capture.kind === "scan";

  return (
    <CardShell question={isGeo ? "A floor scan" : "What is it?"} onSkip={onSkip}>
      {capture.kind === "image" && capture.storageKey ? (
        <Photo storageKey={capture.storageKey} className="aspect-[4/3] w-full" />
      ) : isGeo && capture.storageKey ? (
        <div className="mx-auto w-40">
          <GeojsonThumb storageKey={capture.storageKey} />
        </div>
      ) : (
        <div className="rounded-xl bg-muted/60 p-3 text-[14px] break-words">
          {capture.url ? (
            <a href={capture.url} target="_blank" rel="noreferrer" className="text-[#3C5D41] underline">
              {capture.url}
            </a>
          ) : (
            capture.rawText || "(file without a preview)"
          )}
        </div>
      )}

      {isGeo ? (
        <p className="text-[13px] text-muted-foreground">
          Floor scans are imported in the Workbench.{" "}
          <a href="/inbox" className="text-[#3C5D41] underline">
            Open the Workbench inbox
          </a>
        </p>
      ) : (
        <>
          {suggestion?.note && <p className="text-[12px] text-muted-foreground line-clamp-3">{suggestion.note}</p>}

          {!suggestion && (
            <button
              onClick={() => {
                setError(null);
                triage.mutate({ id: capture.id });
              }}
              disabled={triage.isPending}
              className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#3C5D41] py-3 font-data text-[14px] font-semibold text-[#3C5D41] disabled:opacity-60"
            >
              {triage.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {triage.isPending ? "Looking at the photo…" : "Ask AI what this is"}
            </button>
          )}

          {matched.length > 0 && (
            <p className="text-[12px] text-muted-foreground">
              Already in the inventory: {matched.map((m) => m.matchedItemName).join(", ")}
            </p>
          )}

          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <div key={i} className={cn("flex items-center gap-2 rounded-xl border p-2", r.checked ? "border-[#3C5D41]" : "border-border opacity-60")}>
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                    className="h-5 w-5 accent-[#3C5D41]"
                    aria-label={`File ${r.name}`}
                  />
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <input
                      value={r.name}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      className="w-full rounded-md border border-transparent px-1 py-0.5 text-[14px] font-medium focus:border-input"
                      aria-label="Name"
                    />
                    <select
                      value={r.areaId ?? ""}
                      onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, areaId: Number(e.target.value) } : x)))}
                      className="w-fit rounded-md border border-border bg-white px-1.5 py-0.5 text-[12px] text-muted-foreground"
                      aria-label="Kind"
                    >
                      {areas.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addExtra();
            }}
          >
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={rows.length ? "Add another thing" : "Type what it is"}
              className="flex-1 rounded-lg border border-input px-3 py-2 text-[14px]"
              aria-label="Add a thing by name"
            />
            <button type="submit" disabled={!extra.trim()} className="rounded-lg border border-border px-3 disabled:opacity-40" aria-label="Add">
              <Plus className="h-4 w-4" />
            </button>
          </form>

          <button onClick={() => setPlaceOpen(true)} className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-left text-[13px]">
            <MapPin className="h-4 w-4 shrink-0 text-[#3C5D41]" />
            <span className="flex-1 truncate">{placeLabel(validPlace.roomId, locations) || "No place yet"}</span>
            <span className="text-[12px] text-muted-foreground underline">change</span>
          </button>

          <ErrorLine message={error} />

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button
              disabled={chosen.length === 0 || busy}
              onClick={() =>
                accept.mutate({
                  id: capture.id,
                  roomId: validPlace.roomId,
                  items: chosen.map((r) => ({ areaId: r.areaId!, itemId: null, itemName: r.name.trim(), attributes: r.attributes })),
                })
              }
              className="rounded-xl bg-[#282c20] py-3 font-data text-[14px] font-semibold text-[#f4f4ed] disabled:opacity-40"
            >
              {accept.isPending ? "Filing…" : chosen.length > 1 ? `File ${chosen.length} things` : "File it"}
            </button>
            <button
              disabled={busy}
              onClick={() => dismiss.mutate({ id: capture.id })}
              className="flex items-center gap-1 rounded-xl border border-border px-3 text-[13px] text-muted-foreground disabled:opacity-40"
            >
              <X className="h-4 w-4" /> Not a thing
            </button>
          </div>
        </>
      )}

      {placeOpen && <LocationSheet title="Where is it?" value={validPlace} onPick={setPlace} onClose={() => setPlaceOpen(false)} />}
    </CardShell>
  );
}

function CheckCard({ item, onSkip }: { item: FlowItem; onSkip: () => void }) {
  const { locations, refresh } = useFlow();
  const setVerification = trpc.items.setVerification.useMutation({ onSuccess: refresh });
  return (
    <CardShell question="Is this right?" onSkip={onSkip}>
      {item.imageKey ? (
        <Photo storageKey={item.imageKey} className="aspect-[4/3] w-full" />
      ) : item.roomId != null && item.pos ? (
        <ItemRoomPreview roomId={item.roomId} itemId={item.id} />
      ) : null}
      <div>
        <p className="text-[17px] font-semibold leading-tight">{item.name}</p>
        <p className="text-[12px] text-muted-foreground">
          {[item.areaName, placeLabel(item.roomId, locations)].filter(Boolean).join(" · ")}
        </p>
        {item.description && <p className="mt-1 text-[12px] text-muted-foreground line-clamp-2">{item.description}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          disabled={setVerification.isPending}
          onClick={() => setVerification.mutate({ id: item.id, verificationStatus: "confirmed" })}
          className="rounded-xl bg-[#2F7A45] py-3 font-data text-[14px] font-semibold text-white disabled:opacity-40"
        >
          Yes, it is
        </button>
        <button
          disabled={setVerification.isPending}
          onClick={() => setVerification.mutate({ id: item.id, verificationStatus: "rejected" })}
          className="rounded-xl border-2 border-[#AD432B] py-3 font-data text-[14px] font-semibold text-[#AD432B] disabled:opacity-40"
        >
          No, remove
        </button>
      </div>
      <a href={`/items/${item.id}`} className="text-center text-[12px] text-muted-foreground underline">
        Fix details in the Workbench
      </a>
    </CardShell>
  );
}

function PlaceCard({ item, onSkip }: { item: FlowItem; onSkip: () => void }) {
  const { here, locations, refresh } = useFlow();
  const [open, setOpen] = useState(false);
  const update = trpc.items.update.useMutation({ onSuccess: refresh });
  const put = (p: Place) => update.mutate({ id: item.id, roomId: p.roomId });

  return (
    <CardShell question="Where is it?" onSkip={onSkip}>
      <Photo storageKey={item.imageKey} className="aspect-[4/3] w-full" />
      <div>
        <p className="text-[17px] font-semibold leading-tight">{item.name}</p>
        {item.areaName && <p className="text-[12px] text-muted-foreground">{item.areaName}</p>}
      </div>
      {here.roomId != null && (
        <button
          disabled={update.isPending}
          onClick={() => put(here)}
          className="flex flex-col items-center rounded-xl bg-[#282c20] py-3 text-[#f4f4ed] disabled:opacity-40"
        >
          <span className="font-data text-[14px] font-semibold">Here</span>
          <span className="text-[12px] opacity-75">{placeLabel(here.roomId, locations)}</span>
        </button>
      )}
      <button onClick={() => setOpen(true)} className="rounded-xl border border-border py-3 text-[14px]">
        {here.roomId != null ? "Another place…" : "Pick a place…"}
      </button>
      {open && <LocationSheet title="Where is it?" value={here} onPick={put} onClose={() => setOpen(false)} />}
    </CardShell>
  );
}

function LabItemHeader({ item }: { item: FlowItem }) {
  const { locations } = useFlow();
  return (
    <div className="flex items-center gap-3">
      <Photo storageKey={item.imageKey} className="h-20 w-20 shrink-0" />
      <div className="min-w-0">
        <p className="text-[16px] font-semibold leading-tight">{item.name}</p>
        <p className="text-[12px] text-muted-foreground">
          {[role(item) ? roleLabel(role(item)) : item.areaName, placeLabel(item.roomId, locations)].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
}

function LabDetailsCard({ item, onSkip }: { item: FlowItem; onSkip: () => void }) {
  const { refresh } = useFlow();
  const patch = trpc.items.patchAttributes.useMutation({ onSuccess: refresh });
  return (
    <CardShell question="What device is it?" onSkip={onSkip}>
      <LabItemHeader item={item} />
      <LabFields item={item} requireRole>
        <button
          disabled={patch.isPending}
          onClick={() => patch.mutate({ id: item.id, set: { [LAB_KEYS.exclude]: "yes" } })}
          className="rounded-xl border border-border px-3 text-[13px] text-muted-foreground disabled:opacity-40"
        >
          Not a lab thing
        </button>
      </LabFields>
    </CardShell>
  );
}

function BackupCard({ item, onSkip }: { item: FlowItem; onSkip: () => void }) {
  return (
    <CardShell question="Is it backed up?" onSkip={onSkip}>
      <LabItemHeader item={item} />
      <BackupPicker item={item} />
    </CardShell>
  );
}
