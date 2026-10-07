import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { formatBytes } from "@/components/storage/Blocks";

const STORAGE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas", "storage"]);

/** Volumes on this Thing (or its internal drives). Each row opens Storage with that volume selected. */
export function StorageSection({ itemId, role }: { itemId: number; role?: string }) {
  const overview = trpc.storage.overview.useQuery({ houseId: null });
  const o = overview.data;
  const rows: { deviceName: string; id: number; label: string; used: number; cap: number; dataRole: string | null }[] = [];
  if (o) {
    const take = (deviceName: string, volumes: { id: number; mountPoint: string; label: string | null; usedBytes: number; capacityBytes: number; dataRole: string | null }[]) => {
      for (const v of volumes) {
        rows.push({
          deviceName,
          id: v.id,
          label: v.label ?? v.mountPoint,
          used: v.usedBytes,
          cap: v.capacityBytes,
          dataRole: v.dataRole,
        });
      }
    };
    for (const c of o.computers) {
      if (c.id === itemId) {
        take(c.name, c.volumes);
        for (const d of c.drives) take(d.name, d.volumes);
        for (const d of c.attached) take(`${d.name} (attached)`, d.volumes);
      } else {
        for (const d of [...c.drives, ...c.attached]) if (d.id === itemId) take(d.name, d.volumes);
      }
    }
    for (const d of o.externals) if (d.id === itemId) take(d.name, d.volumes);
  }
  const show = STORAGE_ROLES.has(role ?? "") || rows.length > 0;
  if (!show) return null;
  return (
    <section className="rounded-lg border border-border bg-white p-4">
      <div className="flex items-center mb-2">
        <h2 className="micro-label text-muted-foreground">Storage</h2>
        <Link to={`/storage?item=${itemId}`} className="ml-auto text-[11px] text-primary hover:underline">
          Open Storage
        </Link>
      </div>
      {overview.isLoading && <p className="text-[13px] text-muted-foreground">Loading volumes…</p>}
      {rows.length === 0 && !overview.isLoading && (
        <p className="text-[13px] text-muted-foreground">No measured volumes yet.</p>
      )}
      <ul className="space-y-1">
        {rows.map((v) => (
          <li key={v.id}>
            <Link to={`/storage?volume=${v.id}`} className="flex items-baseline gap-2 text-[13px] text-primary hover:underline">
              <span className="truncate">{v.label}</span>
              {v.deviceName && <span className="text-[11px] text-muted-foreground no-underline">{v.deviceName}</span>}
              <span className="ml-auto shrink-0 font-data text-[11px] text-muted-foreground">
                {formatBytes(v.used)} / {formatBytes(v.cap)}
                {v.dataRole ? ` · ${v.dataRole}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
