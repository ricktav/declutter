import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Loader2, MapPin, Sparkles, Plus, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { GeojsonThumb } from "@/components/GeojsonThumb";
import { ItemRoomPreview } from "@/components/ItemRoomPreview";
import { useFlow } from "./context";
import { LocationSheet } from "./LocationSheet";
import { EmptyState, ErrorLine, FramedPhoto, Photo } from "./ui";
import { BackupPicker, LabFields } from "./LabParts";
import { filterOf, useSortCards, type Card, type Filter } from "./queue";
import { getSnapPlace, isGeojsonKey, placeLabel, usableSuggestion, type FlowCapture, type FlowItem, type Place } from "./data";
import { LAB, LAB_KEYS, role, roleLabel } from "./lenses";
import type { CropBox } from "@db/schema";

// Skipped cards, in skip order, kept on this device so a reload (or the phone
// dropping the tab) does not bring them back to the front. Card keys
// ("c12" = capture 12, "k7" = check Thing 7, ...); capture keys are pruned
// once that capture is no longer pending.
const SKIPPED_KEY = "flow.sort.skipped";
function loadSkipped(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SKIPPED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
function storeSkipped(keys: string[]) {
  try {
    if (keys.length) localStorage.setItem(SKIPPED_KEY, JSON.stringify(keys));
    else localStorage.removeItem(SKIPPED_KEY);
  } catch {
    // storage unavailable - skips then last until a reload, as before
  }
}

/** The frame the AI drew around a spotted Thing (centre + size, percent of the
 * image), or null when it gave none or an unusable one. `box` lands on
 * TriageSpottedItem with sort-triage-boxes; read it loosely until then. */
function spottedBox(s: unknown): CropBox | null {
  const b = (s as { box?: CropBox | null }).box;
  if (!b) return null;
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
  return ok(b.xPct) && ok(b.yPct) && ok(b.wPct) && ok(b.hPct) && b.wPct > 0 && b.hPct > 0 ? b : null;
}

/** Finish the record, one card at a time: what is it, is it right, where is it. */
export function SortTab() {
  const { lens, ready, captures } = useFlow();
  const [filter, setFilter] = useState<Filter>("all");
  const [skipped, setSkipped] = useState<string[]>(loadSkipped);
  // a Photo picked from the strip is worked on first, until it is filed or skipped
  const [picked, setPicked] = useState<string | null>(null);
  const cards = useSortCards();
  // forget skips of captures that left the queue (filed or dismissed); other
  // kinds stay, so a lens toggle or a late-loading list never drops them
  const pruned = ready
    ? skipped.filter((k) => !k.startsWith("c") || captures.some((x) => x.status === "pending" && `c${x.id}` === k))
    : skipped;
  const prunedKey = JSON.stringify(pruned);
  useEffect(() => {
    if (ready) storeSkipped(JSON.parse(prunedKey) as string[]);
  }, [ready, prunedKey]);

  const counts: Record<Filter, number> = { all: cards.length, capture: 0, check: 0, lab: 0, place: 0 };
  for (const c of cards) counts[filterOf(c)]++;
  const visible = cards.filter((x) => filter === "all" || filterOf(x) === filter);
  // skipped cards go to the back of the line instead of disappearing
  const ordered = [
    ...visible.filter((x) => !skipped.includes(x.key)),
    ...skipped.map((k) => visible.find((x) => x.key === k)).filter((x): x is Card => !!x),
  ];
  const card = ordered.find((x) => x.key === picked) ?? ordered[0];
  const photos = ordered.filter((x): x is Extract<Card, { kind: "capture" }> => x.kind === "capture");

  const skip = () => {
    if (!card) return;
    const next = [...pruned.filter((k) => k !== card.key), card.key];
    setSkipped(next);
    storeSkipped(next);
    setPicked(null);
  };

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
          {photos.length > 1 && <PhotoStrip cards={photos} current={card.key} onPick={setPicked} />}
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

/** "Pick a Photo": the pending captures in queue order, tap one to sort it now. */
function PhotoStrip({
  cards,
  current,
  onPick,
}: {
  cards: Extract<Card, { kind: "capture" }>[];
  current: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="px-1 font-data text-[12px] text-muted-foreground">Pick a Photo</span>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 py-0.5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {cards.map(({ key, capture }) => (
          <button
            key={key}
            onClick={() => onPick(key)}
            aria-label={`Sort Photo ${capture.id}`}
            aria-current={key === current}
            className={cn(
              "h-16 w-16 shrink-0 rounded-xl p-0.5 outline-none",
              key === current ? "ring-2 ring-[#3C5D41]" : "ring-1 ring-border",
            )}
          >
            {capture.kind === "image" && capture.storageKey && !isGeojsonKey(capture.storageKey) ? (
              <Photo storageKey={capture.storageKey} className="h-full w-full rounded-[10px]" />
            ) : (
              <span className="grid h-full w-full place-items-center rounded-[10px] bg-muted/60 text-muted-foreground">
                <FileText className="h-5 w-5" />
              </span>
            )}
          </button>
        ))}
      </div>
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

type Row = {
  name: string;
  areaId: number | null;
  checked: boolean;
  attributes?: Record<string, string>;
  /** the AI's frame on the Photo, and the number it shares with its row */
  box?: CropBox;
  num?: number;
};

const LIME = "#a3e635";
const MATCHED = "#e4e4dc";

// "Hide handled": frames of rows dismissed for now and of Things already in the
// inventory are hidden, so only open objects keep their frame. Per device.
const HIDE_HANDLED_KEY = "flow.sort.hideHandled";
function loadHideHandled(): boolean {
  try {
    return localStorage.getItem(HIDE_HANDLED_KEY) !== "0";
  } catch {
    return true;
  }
}
function storeHideHandled(on: boolean) {
  try {
    localStorage.setItem(HIDE_HANDLED_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable - the toggle lasts until a reload
  }
}

/** A spotted object the AI matched to a Thing already in the inventory. */
type MatchedFrame = { num: number; name: string; box: CropBox };

/**
 * The AI's frames over the Photo: one per row that has a box (tap toggles that
 * row) and, unless handled ones are hidden, one per matched Thing (not
 * tappable). Numbers come from the suggestion, so hiding never renumbers.
 */
function Frames({
  rows,
  matched,
  hideHandled,
  active,
  onTap,
}: {
  rows: Row[];
  matched: MatchedFrame[];
  hideHandled: boolean;
  active: number | null;
  onTap: (i: number) => void;
}) {
  type F = { num: number; name: string; box: CropBox; row: number | null; checked: boolean };
  const all: F[] = [
    ...rows.flatMap((r, i) => (r.box && r.num != null ? [{ num: r.num, name: r.name, box: r.box, row: i, checked: r.checked }] : [])),
    ...matched.map((m) => ({ ...m, row: null, checked: false })),
  ];
  // in the DOM by number; stacked by size, so a small frame inside a big one
  // stays on top and tappable
  const framed = all.filter((f) => !hideHandled || (f.row != null && f.checked)).sort((a, b) => a.num - b.num);
  const bySize = [...framed].sort((a, b) => b.box.wPct * b.box.hPct - a.box.wPct * a.box.hPct);
  return (
    <>
      {framed.map((f) => {
        const b = f.box;
        const left = Math.max(0, b.xPct - b.wPct / 2);
        const top = Math.max(0, b.yPct - b.hPct / 2);
        const style = {
          left: `${left}%`,
          top: `${top}%`,
          width: `${Math.min(100, b.xPct + b.wPct / 2) - left}%`,
          height: `${Math.min(100, b.yPct + b.hPct / 2) - top}%`,
          zIndex: 1 + bySize.indexOf(f),
          border: `2px ${f.checked ? "solid" : "dashed"} ${f.row == null ? MATCHED : LIME}`,
        };
        const badge = (
          <span
            aria-hidden
            className="absolute left-0 top-0 grid h-5 min-w-5 place-items-center rounded-br-md px-1 font-data text-[11px] font-bold text-[#282c20]"
            style={{ background: f.row == null ? MATCHED : LIME }}
          >
            {f.num}
          </span>
        );
        const row = f.row;
        return row == null ? (
          <div
            key={`m${f.num}`}
            role="img"
            aria-label={`Frame ${f.num}: ${f.name}, already in the inventory`}
            className="pointer-events-none absolute rounded-sm"
            style={style}
          >
            {badge}
          </div>
        ) : (
          <button
            key={`r${row}`}
            type="button"
            onClick={() => onTap(row)}
            aria-label={`Frame ${f.num}: ${f.name}`}
            aria-pressed={f.checked}
            className={cn("absolute rounded-sm", !f.checked && "opacity-50", active === row && "shadow-[0_0_0_3px_rgba(0,0,0,0.45)]")}
            style={style}
          >
            {badge}
          </button>
        );
      })}
    </>
  );
}

function RowNumber({ num }: { num?: number }) {
  if (num == null) return null;
  return (
    <span aria-hidden className="grid h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 font-data text-[11px] font-bold text-[#282c20]" style={{ background: LIME }}>
      {num}
    </span>
  );
}

type AcceptItems = Parameters<ReturnType<typeof trpc.inbox.acceptMany.useMutation>["mutate"]>[0]["items"];

function CaptureCard({ capture, onSkip }: { capture: FlowCapture; onSkip: () => void }) {
  const { areas, here, locations, lens, refresh } = useFlow();
  const suggestion = usableSuggestion(capture);
  const defaultAreaId = (lens === "lab" ? areas.find((a) => a.slug === LAB.defaultAreaSlug)?.id : undefined) ?? areas[0]?.id ?? null;
  const matched = suggestion?.items.filter((s) => !s.isNewItem && s.matchedItemName) ?? [];
  // frame numbers follow the suggestion's order over every boxed object, rows
  // and matched Things alike, so hiding frames never renumbers them
  const frameNums = new Map<object, number>();
  for (const s of suggestion?.items ?? []) if (spottedBox(s)) frameNums.set(s, frameNums.size + 1);
  const matchedFrames: MatchedFrame[] = matched.flatMap((m) => {
    const box = spottedBox(m);
    const num = frameNums.get(m);
    return box && num != null ? [{ num, name: m.matchedItemName ?? m.itemName, box }] : [];
  });
  const [hideHandled, setHideHandled] = useState(loadHideHandled);

  const initialRows = (): Row[] => (suggestion?.items ?? [])
      .filter((s) => s.isNewItem || !s.matchedItemName)
      .map((s) => {
        const box = spottedBox(s);
        return {
          name: s.itemName,
          areaId: areas.find((a) => a.slug === s.areaSlug)?.id ?? defaultAreaId,
          checked: true,
          attributes: s.attributes,
          ...(box ? { box, num: frameNums.get(s) } : {}),
        };
      });
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [extra, setExtra] = useState("");
  // the row whose frame was tapped last: outlined so the eye finds it
  const [active, setActive] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tapFrame = (i: number) => {
    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, checked: !x.checked } : x)));
    setActive(i);
    rowRefs.current[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
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
        <div className="flex flex-col gap-1">
          <FramedPhoto storageKey={capture.storageKey}>
            <Frames rows={rows} matched={matchedFrames} hideHandled={hideHandled} active={active} onTap={tapFrame} />
          </FramedPhoto>
          {(matchedFrames.length > 0 || rows.some((r) => r.box)) && (
            <label className="flex items-center justify-end gap-1.5 px-1 text-[12px] text-muted-foreground">
              <input
                type="checkbox"
                checked={hideHandled}
                onChange={(e) => {
                  setHideHandled(e.target.checked);
                  storeHideHandled(e.target.checked);
                }}
                className="h-4 w-4 accent-[#3C5D41]"
              />
              Hide handled
            </label>
          )}
        </div>
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
              Already in the inventory:{" "}
              {matched.map((m) => (frameNums.has(m) ? `${m.matchedItemName} (${frameNums.get(m)})` : m.matchedItemName)).join(", ")}
            </p>
          )}

          {rows.length > 0 && (
            <div className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <div
                  key={i}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-xl border p-2 transition-shadow",
                    r.checked ? "border-[#3C5D41]" : "border-border opacity-60",
                    active === i && "ring-2 ring-[#a3e635]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                    className="h-5 w-5 accent-[#3C5D41]"
                    aria-label={`File ${r.name}`}
                  />
                  <RowNumber num={r.num} />
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
                  // `box` (pin + cutout on the server) lands with sort-triage-boxes; until
                  // then the API's input type lacks it and zod strips it on the way in
                  items: chosen.map((r) => ({
                    areaId: r.areaId!,
                    itemId: null,
                    itemName: r.name.trim(),
                    attributes: r.attributes,
                    ...(r.box ? { box: r.box } : {}),
                  })) as AcceptItems,
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
