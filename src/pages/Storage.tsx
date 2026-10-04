import { useMemo, useState } from "react";
import { HardDrive, Server, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { DeviceBlock, ROLE_COLORS, formatBytes } from "@/components/storage/Blocks";

const ROLES = ["unique", "test", "backup", "archive", "system", "media", "scratch"] as const;
type Role = (typeof ROLES)[number];

/** Every computer with its drives and volumes as blocks; click a volume for its biggest directories and its data role. */
export default function StoragePage() {
  const { houseId, houses } = useHouse();
  const [allHouses, setAllHouses] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const overview = trpc.storage.overview.useQuery({ houseId: allHouses ? null : houseId });
  const dirs = trpc.storage.dirs.useQuery({ volumeId: selected ?? 0 }, { enabled: selected != null });
  const setRole = trpc.storage.setRole.useMutation({
    onSuccess: () => {
      utils.storage.overview.invalidate();
      utils.storage.dirs.invalidate();
    },
  });

  const o = overview.data;
  const maxBytes = useMemo(() => {
    if (!o) return 0;
    const all = [...o.computers.flatMap((c) => [c, ...c.drives]), ...o.externals];
    return Math.max(0, ...all.map((d) => d.capacityBytes ?? 0));
  }, [o]);
  const totalCapacity = o?.totals.reduce((s, t) => s + t.capacityBytes, 0) ?? 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Computers with their disks and volumes as blocks: width is capacity, fill is use, colour is the data role. Click a volume for its biggest directories.
          </p>
        </div>
        {houses.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allHouses} onChange={(e) => setAllHouses(e.target.checked)} /> All houses
          </label>
        )}
      </div>

      {o && (
        <section className="mt-6 rounded-lg border border-border bg-white p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">By data role</h2>
            <span className="text-[12px] text-muted-foreground">
              {formatBytes(o.totals.reduce((s, t) => s + t.usedBytes, 0))} used of {formatBytes(totalCapacity)} measured, every house
              {o.unassignedVolumes > 0 && ` · ${o.unassignedVolumes} volume(s) without a role`}
            </span>
          </div>
          <div className="mt-2 flex h-6 w-full overflow-hidden rounded border border-border">
            {o.totals.length === 0 && <div className="w-full bg-muted" />}
            {o.totals.map((t) => (
              <div
                key={t.dataRole ?? "none"}
                title={`${t.dataRole ?? "no role"}: ${formatBytes(t.usedBytes)} used of ${formatBytes(t.capacityBytes)} in ${t.volumes} volume(s)`}
                style={{ width: `${totalCapacity > 0 ? (t.capacityBytes / totalCapacity) * 100 : 0}%`, background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }}
                className="relative border-r border-white/70 last:border-r-0"
              >
                <div className="absolute inset-y-0 left-0 bg-black/25" style={{ width: `${t.capacityBytes > 0 ? (t.usedBytes / t.capacityBytes) * 100 : 0}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {o.totals.map((t) => (
              <span key={t.dataRole ?? "none"} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }} />
                {t.dataRole ?? "no role"} · {formatBytes(t.usedBytes)} / {formatBytes(t.capacityBytes)}
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {overview.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {o?.computers.length === 0 && o.externals.length === 0 && <p className="text-sm text-muted-foreground">No computers, drives or NAS boxes in this house.</p>}
          {o?.computers.map((c) => (
            <section key={c.id} className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{c.name}</h2>
                <span className="text-[12px] text-muted-foreground">{c.kind}{c.roomName ? ` · ${c.roomName}` : ""}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {c.drives.length === 0 || c.volumes.length > 0 ? <DeviceBlock device={c} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} /> : null}
                {c.drives.map((d) => (
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} />
                ))}
              </div>
            </section>
          ))}
          {o && o.externals.length > 0 && (
            <section className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">External drives and NAS</h2>
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {o.externals.map((d) => (
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={setSelected} showParent />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="lg:sticky lg:top-4 h-fit rounded-lg border border-border bg-white p-4">
          {selected == null && <p className="text-sm text-muted-foreground">Select a volume to see its biggest directories and set its data role.</p>}
          {selected != null && dirs.data && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{dirs.data.volume.label ?? dirs.data.volume.mountPoint}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {dirs.data.volume.itemName} · {dirs.data.volume.mountPoint} · {formatBytes(dirs.data.volume.usedBytes)} of {formatBytes(dirs.data.volume.capacityBytes)} · measured {new Date(dirs.data.volume.measuredAt).toLocaleString()}
                  </div>
                </div>
                <button type="button" onClick={() => setSelected(null)} aria-label="Close" className="rounded p-1 hover:bg-accent/40"><X className="h-4 w-4" /></button>
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Data role</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={setRole.isPending}
                      onClick={() => setRole.mutate({ volumeId: selected, dataRole: dirs.data!.volume.dataRole === r ? null : (r as Role) })}
                      className="rounded-full border px-2.5 py-1 text-[12px] disabled:opacity-50"
                      style={dirs.data.volume.dataRole === r ? { background: ROLE_COLORS[r], color: "white", borderColor: ROLE_COLORS[r] } : { borderColor: "var(--border, #e5e7eb)" }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Biggest directories</div>
                {dirs.data.dirs.length === 0 && <p className="mt-1 text-[12px] text-muted-foreground">No directory measurement for this volume yet.</p>}
                <ul className="mt-1 space-y-1">
                  {dirs.data.dirs.map((d) => (
                    <li key={d.path} className="text-[12px]">
                      <div className="flex justify-between gap-2"><span className="truncate" title={d.path}>{d.path}</span><span className="shrink-0 tabular-nums">{formatBytes(d.bytes)}</span></div>
                      <div className="h-1.5 w-full rounded bg-muted"><div className="h-full rounded bg-foreground/60" style={{ width: `${dirs.data!.volume.usedBytes > 0 ? Math.min(100, (d.bytes / dirs.data!.volume.usedBytes) * 100) : 0}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
