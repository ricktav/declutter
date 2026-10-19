import {
  NEUTRAL_PIN_COLOR as NEUTRAL,
  isFramed,
  pinTitle,
  pinTypeLabel,
  visibleSchemaPins,
  type SchemaFilter,
  type SchemaPin,
} from "@/lib/schemaFilter";

const GRID =
  "linear-gradient(to right, rgb(128 128 128 / 0.08) 1px, transparent 1px), linear-gradient(to bottom, rgb(128 128 128 / 0.08) 1px, transparent 1px)";

/**
 * A clean drawing of one Photo: every framed pin that passes the filter is a
 * block at its frame (left = x − w/2, top = y − h/2, in percent of the Photo),
 * in a box with the Photo's aspect ratio. Pure: no queries.
 */
export function PhotoSchematic({
  pins,
  aspect,
  filter,
  showPoints,
  selectedItemId,
  onPick,
}: {
  pins: SchemaPin[];
  /** width / height of the Photo */
  aspect: number;
  filter: SchemaFilter;
  showPoints: boolean;
  selectedItemId?: number | null;
  onPick: (pin: SchemaPin) => void;
}) {
  const visible = visibleSchemaPins(pins, filter, showPoints);
  const blocks = visible.filter(isFramed);
  const points = visible.filter((p) => !isFramed(p));
  return (
    <div
      data-testid="photo-schematic"
      className="relative w-full overflow-hidden rounded bg-background ring-1 ring-border"
      style={{ aspectRatio: String(aspect), backgroundImage: GRID, backgroundSize: "10% 10%" }}
    >
      {blocks.map((p) => {
        const color = p.itemAreaColor ?? NEUTRAL;
        const selected = selectedItemId != null && p.itemId === selectedItemId;
        const typeLabel = pinTypeLabel(p);
        return (
          <button
            key={p.id}
            type="button"
            data-pin-id={p.id}
            title={typeLabel ? `${pinTitle(p)} — ${typeLabel}` : pinTitle(p)}
            onClick={() => onPick(p)}
            className={
              "absolute overflow-hidden rounded-sm px-1 py-0.5 text-left leading-tight hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground" +
              (p.flagged ? " ring-2 ring-amber-500 ring-offset-1" : "") +
              (selected ? " outline outline-2 outline-offset-1 outline-foreground" : "")
            }
            style={{
              left: `${p.xPct - p.wPct! / 2}%`,
              top: `${p.yPct - p.hPct! / 2}%`,
              width: `${p.wPct}%`,
              height: `${p.hPct}%`,
              background: `color-mix(in srgb, ${color} 16%, transparent)`,
              border: `1.5px ${p.status === "suggested" ? "dashed" : "solid"} ${color}`,
            }}
          >
            <span className="block truncate text-[10px] font-medium text-foreground">{pinTitle(p)}</span>
            {typeLabel && <span className="block truncate text-[9px] text-muted-foreground">{typeLabel}</span>}
          </button>
        );
      })}
      {points.map((p) => {
        const color = p.itemAreaColor ?? NEUTRAL;
        return (
          <button
            key={p.id}
            type="button"
            data-pin-id={p.id}
            data-point="1"
            title={pinTitle(p)}
            aria-label={pinTitle(p)}
            onClick={() => onPick(p)}
            className={"absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full" + (p.flagged ? " ring-2 ring-amber-500" : "")}
            style={{
              left: `${p.xPct}%`,
              top: `${p.yPct}%`,
              background: `color-mix(in srgb, ${color} 25%, transparent)`,
              border: `1.5px dashed ${color}`,
            }}
          />
        );
      })}
    </div>
  );
}
