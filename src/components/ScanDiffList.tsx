import { footprintCentre as centre, type ScanDiffChange } from "@/lib/scanDiff";

/**
 * What one scan did to the Place's Things: moved (from → to, centre of the
 * footprint in metres), new, and not in this scan. A click selects the Thing
 * on the plan; a deleted Thing is listed but not clickable.
 */
export function ScanDiffList({
  changes,
  firstScan,
  selectedId,
  onSelect,
}: {
  changes: ScanDiffChange[];
  /** the scan made the Place: everything in it is new, nothing to compare */
  firstScan: boolean;
  selectedId: number | null;
  onSelect: (itemId: number) => void;
}) {
  const moved = changes.filter((c) => c.action === "moved");
  const created = changes.filter((c) => c.action === "created");
  const missing = changes.filter((c) => c.action === "missing");
  const same = changes.filter((c) => c.action === "matched").length;

  const row = (c: ScanDiffChange, tag: string, tagClass: string, detail?: string) => {
    const gone = c.status === "deleted";
    return (
      <li key={`${c.action}-${c.itemId}`}>
        <button
          type="button"
          disabled={gone}
          onClick={() => onSelect(c.itemId)}
          className={`flex w-full items-baseline gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-muted/50 disabled:hover:bg-transparent ${
            selectedId === c.itemId ? "bg-primary/10" : ""
          }`}
        >
          <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${tagClass}`}>{tag}</span>
          <span className={`min-w-0 truncate ${gone ? "text-muted-foreground line-through" : "text-foreground"}`}>{c.name}</span>
          {detail && <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">{detail}</span>}
        </button>
      </li>
    );
  };

  if (changes.length === 0) {
    return <p className="text-[11px] text-muted-foreground">This scan changed only the outline; no Things.</p>;
  }
  return (
    <div className="space-y-1">
      {firstScan && <p className="text-[11px] text-muted-foreground">The first scan of this Place: there is nothing earlier to compare.</p>}
      <ul className="space-y-0.5">
        {moved.map((c) =>
          row(
            c,
            "moved",
            "bg-orange-100 text-orange-800",
            c.posBefore && c.posAfter ? `${centre(c.posBefore)} → ${centre(c.posAfter)} m` : undefined,
          ),
        )}
        {created.map((c) => row(c, "new", "bg-emerald-100 text-emerald-800"))}
        {missing.map((c) => row(c, "not in this scan", "bg-amber-100 text-amber-800"))}
      </ul>
      {same > 0 && (
        <p className="px-1.5 text-[11px] text-muted-foreground">
          {same} {same === 1 ? "Thing" : "Things"} in the same place.
        </p>
      )}
    </div>
  );
}
