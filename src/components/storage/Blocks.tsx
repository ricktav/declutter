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

export type DiskMeasure = "measured" | "no-collector" | "unlinked" | "duplicate";

export type DiskLinkCandidate = { id: number; name: string } | { diskKey: string; name: string };

export type DeviceLike = {
  id: number;
  name: string;
  kind: string;
  driveType: string | null;
  capacityBytes: number | null;
  usedBytes: number | null;
  measured: boolean;
  measure?: DiskMeasure;
  diskKey?: string | null;
  inferred?: boolean;
  linkCandidates?: DiskLinkCandidate[];
  parentId?: number | null;
  backsUp?: Array<{ relationId: number; itemId: number; name: string }>;
  volumes: VolumeLike[];
  stale?: boolean;
  lastSeenLabel?: string | null;
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

function measureCaption(device: DeviceLike): string {
  const m = device.measure ?? (device.measured ? "measured" : "no-collector");
  if (m === "no-collector") return "no collector";
  if (m === "unlinked") return "volumes on this machine aren't linked to this disk";
  if (m === "duplicate") return "duplicate of another disk on this machine";
  if (device.usedBytes != null && device.capacityBytes) return `${Math.round((device.usedBytes / device.capacityBytes) * 100)}% used`;
  return "no use data";
}

function candidateKey(c: DiskLinkCandidate): string {
  return "diskKey" in c ? `k:${c.diskKey}` : `i:${c.id}`;
}

/** Block width follows capacity on a shared scale; the label is not capped by the bar. */
export function DeviceBlock({
  device,
  maxBytes,
  selectedVolumeId,
  onSelectVolume,
  showParent = false,
  tag,
  onLinkDisk,
  linkPending = false,
}: {
  device: DeviceLike;
  maxBytes: number;
  selectedVolumeId: number | null;
  onSelectVolume: (volumeId: number) => void;
  /** External list only: a drive whose computer is archived, in another house or unplaced. */
  showParent?: boolean;
  /** A small tag after the name, e.g. "attached". */
  tag?: string;
  onLinkDisk?: (choice: { itemId: number; diskKey: string }) => void;
  linkPending?: boolean;
}) {
  const cap = device.capacityBytes ?? 0;
  const widthPct = maxBytes > 0 ? Math.max(12, (cap / maxBytes) * 100) : 100;
  const unmeasured = !device.measured;
  const backsUp = device.backsUp ?? [];
  const candidates = device.linkCandidates ?? [];
  const typeLabel = device.driveType ?? (device.inferred ? "disk" : null);
  const stale = device.stale === true;
  return (
    <div className={cn("flex min-w-[16rem] max-w-full flex-col gap-1", stale && "opacity-60")} style={{ flex: `1 1 ${widthPct}%` }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="min-w-0 font-medium break-words">
          {device.name}
          {tag && <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">{tag}</span>}
          {device.inferred && <span className="ml-1.5 rounded border border-dashed border-border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground">inferred</span>}
          {stale && device.lastSeenLabel && (
            <span className="ml-1.5 rounded border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">{device.lastSeenLabel}</span>
          )}
          {showParent && device.parentId != null && <span className="ml-1 font-normal text-muted-foreground">in #{device.parentId}</span>}
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {typeLabel ? `${typeLabel} · ` : ""}
          {formatBytes(device.capacityBytes)}
        </span>
      </div>
      <div
        className={cn("flex h-12 w-full min-w-0 overflow-hidden rounded-md border", unmeasured ? "border-dashed border-border bg-[repeating-linear-gradient(135deg,#f3f4f6_0_6px,#ffffff_6px_12px)]" : "border-border bg-muted")}
        title={unmeasured ? measureCaption(device) : undefined}
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
      <div className="flex min-h-[1.25rem] flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{measureCaption(device)}</span>
        {backsUp.map((b) => (
          <span key={b.relationId} className="rounded-full px-1.5 py-px text-[10px] text-white" style={{ background: ROLE_COLORS.backup }}>
            backs up {b.name}
          </span>
        ))}
      </div>
      {onLinkDisk && candidates.length > 0 && (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{device.inferred ? "This is" : "Mounted as"}</span>
          <select
            className="min-w-0 flex-1 rounded border border-border bg-white px-1.5 py-0.5 text-[11px] disabled:opacity-50"
            disabled={linkPending}
            defaultValue=""
            aria-label={device.inferred ? "Link inferred disk to inventory" : "Link disk to measured volumes"}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if (device.inferred && v.startsWith("i:")) onLinkDisk({ itemId: Number(v.slice(2)), diskKey: device.diskKey ?? "unknown" });
              else if (!device.inferred && v.startsWith("k:")) onLinkDisk({ itemId: device.id, diskKey: v.slice(2) });
              e.target.value = "";
            }}
          >
            <option value="">{device.inferred ? "inventory disk…" : "device…"}</option>
            {candidates.map((c) => (
              <option key={candidateKey(c)} value={candidateKey(c)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
