import { Component, useState, type ReactNode } from "react";
import { X, ImageOff } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import type { ItemDecision } from "@db/schema";
import { DECISIONS } from "./data";

/** A stored photo by key, with a hatched placeholder while it loads or when there is none. */
export function Photo({ storageKey, className }: { storageKey: string | null | undefined; className?: string }) {
  const url = trpc.attachments.url.useQuery({ key: storageKey ?? "" }, { enabled: !!storageKey });
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-[repeating-linear-gradient(45deg,hsl(110_14%_92%)_0_8px,hsl(110_8%_86%)_8px_9px)]",
        className,
      )}
    >
      {url.data?.url ? (
        <img src={url.data.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        !storageKey && (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <ImageOff className="h-6 w-6" />
          </div>
        )
      )}
    </div>
  );
}

/**
 * A stored photo shown whole (never cropped), in a box with the image's own
 * aspect ratio, so overlay children positioned in percent (frames, pins) land
 * on the same spot of the picture at any width. Tall photos are capped at
 * `maxHeight` and centred; the box shrinks with them, keeping the ratio.
 */
// natural width / height per photo, so a Photo seen before opens at its real
// ratio instead of jumping from the 4:3 placeholder again
const photoRatios = new Map<string, number>();

export function FramedPhoto({
  storageKey,
  children,
  maxHeight = "60dvh",
}: {
  storageKey: string;
  children?: ReactNode;
  maxHeight?: string;
}) {
  const url = trpc.attachments.url.useQuery({ key: storageKey });
  // natural width / height, known once the image has loaded; 4:3 until then
  const [ratio, setRatio] = useState<number | null>(() => photoRatios.get(storageKey) ?? null);
  const r = ratio ?? 4 / 3;
  return (
    <div className="flex w-full justify-center">
      <div
        className="relative overflow-hidden rounded-xl bg-[repeating-linear-gradient(45deg,hsl(110_14%_92%)_0_8px,hsl(110_8%_86%)_8px_9px)]"
        style={{ aspectRatio: String(r), width: `min(100%, calc(${maxHeight} * ${r}))` }}
      >
        {url.data?.url && (
          <img
            src={url.data.url}
            alt=""
            className="absolute inset-0 h-full w-full"
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) {
                photoRatios.set(storageKey, w / h);
                setRatio(w / h);
              }
            }}
          />
        )}
        {ratio != null && children}
      </div>
    </div>
  );
}

/** Bottom sheet over the app - one task at a time, closes back to where you were. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-background px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" />
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-data text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1 text-muted-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The five answers to "Keep it?" - Keep spans the full row because it is the common answer. */
export function DecisionButtons({
  onPick,
  current,
  disabled,
}: {
  onPick: (d: ItemDecision) => void;
  current?: ItemDecision | null;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {DECISIONS.map((d) => (
        <button
          key={d.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(d.key)}
          className={cn(
            "rounded-xl border-2 py-3 font-data text-[14px] font-semibold transition-opacity disabled:opacity-40",
            d.key === "keep" && "col-span-2",
          )}
          style={{
            color: current === d.key ? "#fff" : d.color,
            borderColor: d.color,
            background: current === d.key ? d.color : `color-mix(in srgb, ${d.color} 8%, transparent)`,
          }}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

export function DecisionBadge({ decision }: { decision: ItemDecision | null | undefined }) {
  const d = DECISIONS.find((x) => x.key === decision);
  if (!d) return null;
  return (
    <span
      className="font-data text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-px"
      style={{ color: d.color, border: `1px solid ${d.color}` }}
    >
      {d.label}
    </span>
  );
}

/** Progress ring - finished part in moss, the rest as a pale track. */
export function Ring({ value, total, size = 120, label }: { value: number; total: number; size?: number; label?: string }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${total} ${label ?? ""}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(110 8% 84%)" strokeWidth="9" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#3C5D41"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${frac * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="48%" textAnchor="middle" className="font-data" fontSize={size / 5.5} fontWeight="700" fill="currentColor">
        {value} / {total}
      </text>
      {label && (
        <text x="50%" y="64%" textAnchor="middle" fontSize={size / 11} fill="hsl(110 4% 42%)">
          {label}
        </text>
      )}
    </svg>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-white/60 px-5 py-10 text-center">
      <p className="font-data text-[15px] font-semibold">{title}</p>
      {children && <div className="mt-2 text-[13px] text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Keeps one broken card from blanking the whole app - shows the error and a way back. */
export class ScreenBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-900">
        <p className="font-data font-semibold">This screen stopped with an error.</p>
        <p className="break-words opacity-80">{this.state.error.message}</p>
        <button onClick={() => location.reload()} className="self-start rounded-lg bg-red-900 px-3 py-1.5 text-white">
          Reload
        </button>
      </div>
    );
  }
}

export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{message}</p>;
}
