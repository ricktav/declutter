import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { HardDrive, ListTodo, Server, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { DeviceBlock, ROLE_COLORS, formatBytes } from "@/components/storage/Blocks";

const ROLES = ["unique", "test", "backup", "archive", "system", "media", "scratch"] as const;
type Role = (typeof ROLES)[number];

function measureDirsTask(v: { itemId: number; itemName: string; mountPoint: string; label: string | null }) {
  const vol = v.label && v.label !== v.mountPoint ? `${v.label} (${v.mountPoint})` : v.mountPoint;
  const cmd =
    v.mountPoint === "/"
      ? `node scripts/storage-report-local.mjs --item ${v.itemId}`
      : `node scripts/storage-report-local.mjs --item ${v.itemId} --only ${v.mountPoint}`;
  return {
    title: `Measure directories on ${v.itemName}: ${vol}`,
    notes: `No directory sizes yet for ${vol} on ${v.itemName} (item ${v.itemId}).\n\nOn that machine:\n${cmd}`,
  };
}

/** Every computer with its drives and volumes as blocks; click a volume for its biggest directories and its data role. */
export default function StoragePage() {
  const { houseId, houses } = useHouse();
  const [searchParams, setSearchParams] = useSearchParams();
  const idParam = (key: string) => {
    const n = Number(searchParams.get(key));
    return Number.isInteger(n) && n > 0 ? n : NaN;
  };
  const volumeParam = idParam("volume");
  const itemParam = idParam("item");
  const [allHouses, setAllHouses] = useState(() => Number.isInteger(volumeParam) || Number.isInteger(itemParam));
  const [selected, setSelected] = useState<number | null>(() =>
    Number.isInteger(volumeParam) ? volumeParam : null,
  );
  const utils = trpc.useUtils();
  const overview = trpc.storage.overview.useQuery({ houseId: allHouses ? null : houseId });
  const o = overview.data;
  const dirs = trpc.storage.dirs.useQuery({ volumeId: selected ?? 0 }, { enabled: selected != null });
  const setRole = trpc.storage.setRole.useMutation({
    onSuccess: () => {
      utils.storage.overview.invalidate();
      utils.storage.dirs.invalidate();
    },
  });

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskCreatedId, setTaskCreatedId] = useState<number | null>(null);
  const createTask = trpc.tasks.create.useMutation({
    onSuccess: (row) => {
      setTaskCreatedId(row.id);
      setAddingTask(false);
      void utils.tasks.list.invalidate();
    },
  });
  const removeVolume = trpc.storage.removeVolume.useMutation({
    onSuccess: () => {
      select(null);
      utils.storage.overview.invalidate();
    },
  });
  // the second click must come within 5 s
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 5000);
    return () => clearTimeout(t);
  }, [confirmRemove]);
  // a new selection starts the confirm over
  const select = (volumeId: number | null) => {
    setSelected(volumeId);
    setConfirmRemove(false);
    setAttachError(null);
    setAddingTask(false);
    setTaskTitle("");
    setTaskNotes("");
    setTaskCreatedId(null);
    const next = new URLSearchParams(searchParams);
    if (volumeId != null) next.set("volume", String(volumeId));
    else next.delete("volume");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (Number.isInteger(volumeParam)) {
      setSelected(volumeParam);
      setAllHouses(true);
    }
  }, [volumeParam]);

  useEffect(() => {
    if (!o || !Number.isInteger(itemParam) || selected != null) return;
    const vols: number[] = [];
    for (const c of o.computers) {
      if (c.id === itemParam) vols.push(...c.volumes.map((v) => v.id), ...c.drives.flatMap((d) => d.volumes.map((v) => v.id)), ...c.attached.flatMap((d) => d.volumes.map((v) => v.id)));
      else {
        for (const d of [...c.drives, ...c.attached]) if (d.id === itemParam) vols.push(...d.volumes.map((v) => v.id));
      }
    }
    for (const d of o.externals) if (d.id === itemParam) vols.push(...d.volumes.map((v) => v.id));
    if (vols[0] != null) select(vols[0]);
  }, [o, itemParam, selected]);

  useEffect(() => {
    if (selected == null) return;
    const el = document.getElementById(`storage-volume-${selected}`) ?? document.getElementById(`storage-item-${itemParam}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, o, itemParam]);

  const maxBytes = useMemo(() => {
    if (!o) return 0;
    const all = [...o.computers.flatMap((c) => [c, ...c.drives, ...c.attached]), ...o.externals];
    return Math.max(0, ...all.map((d) => d.capacityBytes ?? 0));
  }, [o]);
  const totalUsed = o?.totals.reduce((s, t) => s + t.usedBytes, 0) ?? 0;
  const barBytes = o ? Math.max(o.capacityBytes, totalUsed + Math.max(0, o.freeBytes)) : 0;

  // the device that holds the selected volume, and where the overview draws it
  const holder = (() => {
    if (!o || selected == null) return null;
    const has = (d: { volumes: { id: number }[] }) => d.volumes.some((v) => v.id === selected);
    for (const c of o.computers) {
      if (has(c)) return { device: c, hostId: null, attachable: false };
      const drive = c.drives.find(has);
      if (drive) return { device: drive, hostId: null, attachable: false };
      const att = c.attached.find(has);
      if (att) return { device: att, hostId: c.id, attachable: true };
    }
    const ext = o.externals.find(has);
    return ext ? { device: ext, hostId: null, attachable: true } : null;
  })();

  const addRelation = trpc.items.addRelation.useMutation();
  const removeRelation = trpc.items.removeRelation.useMutation();
  const [attaching, setAttaching] = useState(false);
  // drive → computer: drop the old attached-to relation first, then add the new one ("" = none)
  const attachTo = async (deviceId: number, oldRelationId: number | null, value: string) => {
    setAttaching(true);
    setAttachError(null);
    try {
      if (oldRelationId != null) await removeRelation.mutateAsync({ id: oldRelationId });
      if (value !== "") await addRelation.mutateAsync({ fromItemId: deviceId, toItemId: Number(value), type: "attached-to" });
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttaching(false);
      await utils.storage.overview.invalidate();
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Storage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Computers with their disks and volumes as blocks: width is capacity, each volume is a segment as wide as its use, colour is the data role, the light rest is free. Click a volume for its biggest directories.
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
              {formatBytes(totalUsed)} used of {formatBytes(o.capacityBytes)}, every house
              {o.unassignedVolumes > 0 && ` · ${o.unassignedVolumes} volume(s) without a role`}
            </span>
          </div>
          <div className="mt-2 flex h-6 w-full overflow-hidden rounded border border-border">
            {barBytes === 0 && <div className="w-full bg-muted" />}
            {o.totals.map((t) => (
              <div
                key={t.dataRole ?? "none"}
                title={`${t.dataRole ?? "no role"}: ${formatBytes(t.usedBytes)} used in ${t.volumes} volume(s)`}
                style={{ width: `${barBytes > 0 ? (t.usedBytes / barBytes) * 100 : 0}%`, background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }}
                className="relative shrink-0 border-r border-white/70"
              />
            ))}
            {barBytes > 0 && o.freeBytes > 0 && <div className="flex-1 bg-muted" title={`free: ${formatBytes(o.freeBytes)}`} />}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
            {o.totals.map((t) => (
              <span key={t.dataRole ?? "none"} className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: t.dataRole ? ROLE_COLORS[t.dataRole] : "#9ca3af" }} />
                {t.dataRole ?? "no role"} · {formatBytes(t.usedBytes)}
              </span>
            ))}
            {o.freeBytes > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm border border-border bg-muted" />
                free · {formatBytes(o.freeBytes)}
              </span>
            )}
          </div>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {overview.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {overview.isError && <p className="text-sm text-red-600">{overview.error.message}</p>}
          {o?.computers.length === 0 && o.externals.length === 0 && <p className="text-sm text-muted-foreground">No computers, drives or NAS boxes in this house.</p>}
          {o?.computers.map((c) => (
            <section id={`storage-item-${c.id}`} className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{c.name}</h2>
                <span className="text-[12px] text-muted-foreground">{c.kind}{c.roomName ? ` · ${c.roomName}` : ""}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {c.drives.length === 0 || c.volumes.length > 0 ? <DeviceBlock device={c} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={select} /> : null}
                {c.drives.map((d) => (
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={select} />
                ))}
              </div>
              {c.attached.length > 0 && (
                <div className="mt-3 flex flex-wrap items-start gap-4 border-t border-dashed border-border pt-3">
                  {c.attached.map((d) => (
                    <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={select} tag="attached" />
                  ))}
                </div>
              )}
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
                  <DeviceBlock key={d.id} device={d} maxBytes={maxBytes} selectedVolumeId={selected} onSelectVolume={select} showParent />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="lg:sticky lg:top-4 h-fit rounded-lg border border-border bg-white p-4">
          {selected == null && <p className="text-sm text-muted-foreground">Select a volume to see its biggest directories and set its data role.</p>}
          {selected != null && dirs.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {selected != null && dirs.isError && <p className="text-sm text-red-600">{dirs.error.message}</p>}
          {selected != null && dirs.data && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{dirs.data.volume.label ?? dirs.data.volume.mountPoint}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {dirs.data.volume.itemName} · {dirs.data.volume.mountPoint} · {formatBytes(dirs.data.volume.usedBytes)} of {formatBytes(dirs.data.volume.capacityBytes)} · measured {new Date(dirs.data.volume.measuredAt).toLocaleString()}
                  </div>
                </div>
                <button type="button" onClick={() => select(null)} aria-label="Close" className="rounded p-1 hover:bg-accent/40"><X className="h-4 w-4" /></button>
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Data role</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={setRole.isPending}
                      aria-pressed={dirs.data.volume.dataRole === r}
                      onClick={() => setRole.mutate({ volumeId: selected, dataRole: dirs.data!.volume.dataRole === r ? null : (r as Role) })}
                      className="rounded-full border px-2.5 py-1 text-[12px] disabled:opacity-50"
                      style={dirs.data.volume.dataRole === r ? { background: ROLE_COLORS[r], color: "white", borderColor: ROLE_COLORS[r] } : { borderColor: "var(--border, #e5e7eb)" }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                {setRole.isError && <p className="mt-1 text-[12px] text-red-600">{setRole.error.message}</p>}
              </div>
              <div>
                <div className="micro-label text-muted-foreground">Biggest directories</div>
                {dirs.data.dirs.length === 0 && (
                  <div className="mt-1 space-y-2">
                    <p className="text-[12px] text-muted-foreground">No directory measurement for this volume yet.</p>
                    {taskCreatedId != null ? (
                      <p className="text-[12px]">
                        <Link to="/tasks" className="text-foreground underline-offset-2 hover:underline">
                          Task added →
                        </Link>
                      </p>
                    ) : addingTask ? (
                      <div className="space-y-1.5">
                        <input
                          className="w-full rounded border border-input px-2 py-1 text-[12px]"
                          value={taskTitle}
                          onChange={(e) => setTaskTitle(e.target.value)}
                          aria-label="Task title"
                          autoFocus
                        />
                        <textarea
                          className="w-full rounded border border-input px-2 py-1 text-[12px] font-data min-h-[4.5rem]"
                          value={taskNotes}
                          onChange={(e) => setTaskNotes(e.target.value)}
                          aria-label="Task notes"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!taskTitle.trim() || createTask.isPending}
                            onClick={() =>
                              createTask.mutate({
                                title: taskTitle.trim(),
                                notes: taskNotes.trim() || undefined,
                                itemId: dirs.data!.volume.itemId,
                              })
                            }
                            className="rounded border border-border px-2 py-1 text-[12px] disabled:opacity-50 hover:bg-accent/40"
                          >
                            {createTask.isPending ? "Adding…" : "Add task"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setAddingTask(false)}
                            className="text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                        {createTask.isError && <p className="text-[12px] text-red-600">{createTask.error.message}</p>}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          const draft = measureDirsTask(dirs.data!.volume);
                          setTaskTitle(draft.title);
                          setTaskNotes(draft.notes);
                          setAddingTask(true);
                        }}
                        className="inline-flex items-center gap-1 text-[12px] text-foreground underline-offset-2 hover:underline"
                      >
                        <ListTodo className="h-3 w-3" /> Add task
                      </button>
                    )}
                  </div>
                )}
                <ul className="mt-1 space-y-1">
                  {dirs.data.dirs.map((d) => (
                    <li key={d.path} className="text-[12px]">
                      <div className="flex justify-between gap-2"><span className="truncate" title={d.path}>{d.path}</span><span className="shrink-0 tabular-nums">{formatBytes(d.bytes)}</span></div>
                      <div className="h-1.5 w-full rounded bg-muted"><div className="h-full rounded bg-foreground/60" style={{ width: `${dirs.data!.volume.usedBytes > 0 ? Math.min(100, (d.bytes / dirs.data!.volume.usedBytes) * 100) : 0}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </div>
              {holder?.attachable && o && (
                <div>
                  <label className="micro-label text-muted-foreground" htmlFor="storage-attached-to">Attached to</label>
                  <select
                    id="storage-attached-to"
                    className="mt-1 block w-full rounded border border-border bg-white px-2 py-1 text-[12px] disabled:opacity-50"
                    disabled={attaching}
                    value={holder.hostId != null ? String(holder.hostId) : holder.device.attachedRelationId != null ? "elsewhere" : ""}
                    onChange={(e) => {
                      if (e.target.value === "elsewhere") return;
                      void attachTo(holder.device.id, holder.device.attachedRelationId, e.target.value);
                    }}
                  >
                    <option value="">— none —</option>
                    {holder.hostId == null && holder.device.attachedRelationId != null && (
                      <option value="elsewhere" disabled>a computer not shown here</option>
                    )}
                    {o.computers.map((c) => (
                      <option key={c.id} value={String(c.id)}>{c.name}</option>
                    ))}
                  </select>
                  {attachError && <p className="mt-1 text-[12px] text-red-600">{attachError}</p>}
                </div>
              )}
              <div className="border-t border-border pt-2">
                <button
                  type="button"
                  disabled={removeVolume.isPending}
                  onClick={() => (confirmRemove ? removeVolume.mutate({ volumeId: selected }) : setConfirmRemove(true))}
                  className="text-[12px] text-red-700 underline-offset-2 hover:underline disabled:opacity-50"
                >
                  {confirmRemove ? "Really remove?" : "Remove volume"}
                </button>
                {removeVolume.isError && <p className="mt-1 text-[12px] text-red-600">{removeVolume.error.message}</p>}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
