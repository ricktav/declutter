import { cn } from "@/lib/utils";

// eslint-disable-next-line react-refresh/only-export-components -- small helpers that belong with the blocks
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

// eslint-disable-next-line react-refresh/only-export-components -- small helpers that belong with the blocks
export const ROLE_COLORS: Record<string, string> = {
  unique: "#b91c1c",
  test: "#a16207",
  backup: "#15803d",
  archive: "#1d4ed8",
  system: "#6b7280",
  media: "#7e22ce",
  scratch: "#c2410c",
};

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function isStale(measuredAt: Date | string): boolean {
  const t = new Date(measuredAt).getTime();
  return Number.isFinite(t) && Date.now() - t > STALE_MS;
}

export type VolumeLike = {
  id: number;
  mountPoint: string;
  label: string | null;
  /** APFS container: volumes sharing it share its capacity. Null = its own container. */
  container: string | null;
  /** The container's capacity (the same on every volume of one container). */
  capacityBytes: number;
  usedBytes: number;
  /** used ÷ container capacity */
  shareOfContainer: number;
  dataRole: string | null;
  measuredAt: Date | string;
};

export type DeviceLike = {
  id: number;
  name: string;
  kind: string;
  driveType: string | null;
  capacityBytes: number | null;
  usedBytes: number | null;
  measured: boolean;
  parentId?: number | null;
  backsUp?: Array<{ relationId: number; itemId: number; name: string }>;
  volumes: VolumeLike[];
};

type Segment = { kind: "volume"; volume: VolumeLike; widthPct: number } | { kind: "free"; key: string; bytes: number; widthPct: number };

/**
 * Per container: its volumes (each its share of the container) then the
 * container's free rest. Containers split the block by capacity, so one
 * container drawn alone fills the block with its volumes plus free.
 */
function segmentsOf(volumes: VolumeLike[]): Segment[] {
  const groups = new Map<string, { capacity: number; volumes: VolumeLike[] }>();
  for (const v of volumes) {
    const key = v.container ?? `vol:${v.id}`;
    const g = groups.get(key) ?? { capacity: 0, volumes: [] };
    g.capacity = Math.max(g.capacity, v.capacityBytes);
    g.volumes.push(v);
    groups.set(key, g);
  }
  const total = [...groups.values()].reduce((s, g) => s + g.capacity, 0);
  const out: Segment[] = [];
  for (const [key, g] of groups) {
    const part = total > 0 ? g.capacity / total : 0;
    let share = 0;
    for (const v of g.volumes) {
      const s = Math.max(0, v.shareOfContainer);
      share += s;
      out.push({ kind: "volume", volume: v, widthPct: s * part * 100 });
    }
    const freeShare = Math.max(0, 1 - share);
    if (freeShare > 0) out.push({ kind: "free", key, bytes: freeShare * g.capacity, widthPct: freeShare * part * 100 });
  }
  return out;
}

/** Block width follows capacity on a shared scale; volumes are segments by their use, the light rest is free. */
export function DeviceBlock({
  device,
  maxBytes,
  selectedVolumeId,
  onSelectVolume,
  showParent = false,
  tag,
}: {
  device: DeviceLike;
  maxBytes: number;
  selectedVolumeId: number | null;
  onSelectVolume: (volumeId: number) => void;
  /** External list only: a drive whose computer is archived, in another house or unplaced. */
  showParent?: boolean;
  /** A small tag after the name, e.g. "attached". */
  tag?: string;
}) {
  const cap = device.capacityBytes ?? 0;
  const widthPct = maxBytes > 0 ? Math.max(8, (cap / maxBytes) * 100) : 100;
  const unmeasured = !device.measured;
  const backsUp = device.backsUp ?? [];
  return (
    <div className="flex flex-col gap-1" style={{ width: `${widthPct}%`, minWidth: 96 }}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate font-medium">
          {device.name}
          {tag && <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">{tag}</span>}
          {showParent && device.parentId != null && <span className="ml-1 font-normal text-muted-foreground">in #{device.parentId}</span>}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {device.driveType ? `${device.driveType} · ` : ""}
          {formatBytes(device.capacityBytes)}
        </span>
      </div>
      {backsUp.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {backsUp.map((b) => (
            <span key={b.relationId} className="rounded-full px-1.5 py-px text-[10px] text-white" style={{ background: ROLE_COLORS.backup }}>
              backs up {b.name}
            </span>
          ))}
        </div>
      )}
      <div
        className={cn("flex h-12 w-full overflow-hidden rounded-md border", unmeasured ? "border-dashed border-border bg-[repeating-linear-gradient(135deg,#f3f4f6_0_6px,#ffffff_6px_12px)]" : "border-border bg-muted")}
        title={unmeasured ? "No measurement yet: block from storage_gb / storage_free_gb" : undefined}
      >
        {unmeasured ? (
          <div className="h-full bg-muted-foreground/30" style={{ width: cap > 0 && device.usedBytes != null ? `${(device.usedBytes / cap) * 100}%` : "0%" }} />
        ) : (
          segmentsOf(device.volumes).map((seg) =>
            seg.kind === "free" ? (
              <div key={`free:${seg.key}`} className="h-full bg-muted" style={{ width: `${seg.widthPct}%` }} title={`free · ${formatBytes(seg.bytes)}`} />
            ) : (
              <button
                key={seg.volume.id}
                id={`storage-volume-${seg.volume.id}`}
                type="button"
                onClick={() => onSelectVolume(seg.volume.id)}
                className={cn("relative h-full shrink-0 border-r border-white/70 text-left outline-none", selectedVolumeId === seg.volume.id && "ring-2 ring-inset ring-black", isStale(seg.volume.measuredAt) && "opacity-60")}
                style={{ width: `${seg.widthPct}%`, minWidth: 4, background: seg.volume.dataRole ? ROLE_COLORS[seg.volume.dataRole] : "#9ca3af" }}
                title={`${seg.volume.label ?? seg.volume.mountPoint} · ${formatBytes(seg.volume.usedBytes)} used of ${formatBytes(seg.volume.capacityBytes)}${seg.volume.container ? ` (shared by container ${seg.volume.container})` : ""}${seg.volume.dataRole ? ` · ${seg.volume.dataRole}` : " · no data role"}${isStale(seg.volume.measuredAt) ? " · stale" : ""}`}
              >
                <span className="absolute inset-x-1 bottom-0.5 truncate text-[10px] leading-none text-white">{seg.volume.label ?? seg.volume.mountPoint}</span>
              </button>
            ),
          )
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {device.usedBytes != null && device.capacityBytes ? `${Math.round((device.usedBytes / device.capacityBytes) * 100)}% used` : "no use data"}
        {unmeasured && " · unmeasured"}
      </div>
    </div>
  );
}
