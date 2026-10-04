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
  capacityBytes: number;
  usedBytes: number;
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
  volumes: VolumeLike[];
};

/** Block width follows capacity on a shared scale; the fill is use. Volumes split the block. */
export function DeviceBlock({
  device,
  maxBytes,
  selectedVolumeId,
  onSelectVolume,
  showParent = false,
}: {
  device: DeviceLike;
  maxBytes: number;
  selectedVolumeId: number | null;
  onSelectVolume: (volumeId: number) => void;
  /** External list only: a drive whose computer is archived, in another house or unplaced. */
  showParent?: boolean;
}) {
  const cap = device.capacityBytes ?? 0;
  const widthPct = maxBytes > 0 ? Math.max(8, (cap / maxBytes) * 100) : 100;
  const unmeasured = !device.measured;
  return (
    <div className="flex flex-col gap-1" style={{ width: `${widthPct}%`, minWidth: 96 }}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate font-medium">
          {device.name}
          {showParent && device.parentId != null && <span className="ml-1 font-normal text-muted-foreground">in #{device.parentId}</span>}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {device.driveType ? `${device.driveType} · ` : ""}
          {formatBytes(device.capacityBytes)}
        </span>
      </div>
      <div
        className={cn("flex h-12 w-full overflow-hidden rounded-md border", unmeasured ? "border-dashed border-border bg-[repeating-linear-gradient(135deg,#f3f4f6_0_6px,#ffffff_6px_12px)]" : "border-border bg-muted")}
        title={unmeasured ? "No measurement yet: block from storage_gb / storage_free_gb" : undefined}
      >
        {unmeasured ? (
          <div className="h-full bg-muted-foreground/30" style={{ width: cap > 0 && device.usedBytes != null ? `${(device.usedBytes / cap) * 100}%` : "0%" }} />
        ) : (
          device.volumes.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectVolume(v.id)}
              className={cn("relative h-full border-r border-white/70 last:border-r-0 text-left outline-none", selectedVolumeId === v.id && "ring-2 ring-inset ring-black", isStale(v.measuredAt) && "opacity-60")}
              style={{ width: `${cap > 0 ? (v.capacityBytes / cap) * 100 : 100}%` }}
              title={`${v.label ?? v.mountPoint} · ${formatBytes(v.usedBytes)} of ${formatBytes(v.capacityBytes)}${v.dataRole ? ` · ${v.dataRole}` : " · no data role"}${isStale(v.measuredAt) ? " · stale" : ""}`}
            >
              <div className="absolute inset-y-0 left-0" style={{ width: `${v.capacityBytes > 0 ? (v.usedBytes / v.capacityBytes) * 100 : 0}%`, background: v.dataRole ? ROLE_COLORS[v.dataRole] : "#9ca3af" }} />
              <span className="absolute inset-x-1 bottom-0.5 truncate text-[10px] leading-none text-black/80 mix-blend-multiply">{v.label ?? v.mountPoint}</span>
            </button>
          ))
        )}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {device.usedBytes != null && device.capacityBytes ? `${Math.round((device.usedBytes / device.capacityBytes) * 100)}% used` : "no use data"}
        {unmeasured && " · unmeasured"}
      </div>
    </div>
  );
}
