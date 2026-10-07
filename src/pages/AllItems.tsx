import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Thumb } from "@/components/Thumb";
import { timeAgo } from "@/lib/format";
import { Archive, LayoutGrid, List as ListIcon, Search, Trash2, FolderInput, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { Button } from "@/components/ui/button";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RoomPicker } from "@/components/RoomPicker";
import { AreaPicker } from "@/components/AreaPicker";
import { SortableTh, nextSort, type SortDir } from "@/components/SortableTh";

type ItemRow = {
  id: number;
  name: string;
  areaId: number;
  areaName: string | null;
  areaSlug: string | null;
  roomId: number | null;
  room: { id: number; name: string; floor: string | null } | null;
  updatedAt: Date | string;
  imageKey: string | null;
  status: string;
  verificationStatus: string;
};

export default function AllItems() {
  const [searchParams, setSearchParams] = useSearchParams();
  const roomIdParam = searchParams.get("roomId");
  const initialRoom =
    roomIdParam && roomIdParam !== "none" && Number.isFinite(Number(roomIdParam)) ? Number(roomIdParam) : null;

  const items = trpc.items.listAll.useQuery({ includeArchived: false, houseId: null });
  const roomsQuery = trpc.rooms.list.useQuery({ houseId: null });
  const areasQuery = trpc.areas.list.useQuery();
  const [q, setQ] = useState("");
  const [view, setView] = usePersistedState<"list" | "gallery">("allItems.view", "list");
  const [sortKey, setSortKey] = usePersistedState<string>("allItems.colSort", "updated");
  const [sortDir, setSortDir] = usePersistedState<SortDir>("allItems.colDir", "desc");
  const [roomIds, setRoomIds] = useState<number[]>(initialRoom != null ? [initialRoom] : []);
  const [areaId, setAreaId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [moveRoomId, setMoveRoomId] = useState<number | null>(null);
  const [moveAreaId, setMoveAreaId] = useState<number | null>(null);
  const [rowAction, setRowAction] = useState<{ id: number; name: string; kind: "move" | "topic" } | null>(null);

  useEffect(() => {
    if (initialRoom != null) setRoomIds([initialRoom]);
  }, [initialRoom]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (items.data ?? []).filter((i) => {
      if (areaId != null && i.areaId !== areaId) return false;
      if (roomIds.length > 0 && (i.roomId == null || !roomIds.includes(i.roomId))) return false;
      if (!query) return true;
      return (
        i.name.toLowerCase().includes(query) ||
        (i.room?.name ?? "").toLowerCase().includes(query) ||
        (i.room?.floor ?? "").toLowerCase().includes(query) ||
        (i.areaName ?? "").toLowerCase().includes(query)
      );
    });
  }, [items.data, q, areaId, roomIds]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const cmp = (l: string, r: string) => l.localeCompare(r) * dir;
      if (sortKey === "name") return cmp(a.name, b.name);
      if (sortKey === "topic") return cmp(a.areaName ?? "", b.areaName ?? "");
      if (sortKey === "location") return cmp(a.room?.name ?? "", b.room?.name ?? "");
      return (+new Date(a.updatedAt) - +new Date(b.updatedAt)) * dir;
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const onSort = (column: string) => {
    const next = nextSort(sortKey, sortDir, column);
    setSortKey(next.key);
    setSortDir(next.dir);
  };

  const visibleIds = sorted.map((i) => i.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });
  };
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const utils = trpc.useUtils();
  const refresh = () => {
    utils.items.listAll.invalidate();
    utils.items.get.invalidate();
    utils.areas.list.invalidate();
    utils.rooms.list.invalidate();
    setSelected(new Set());
  };
  const updateMany = trpc.items.updateMany.useMutation({
    onSuccess: () => {
      refresh();
      setMoveOpen(false);
      setTopicOpen(false);
      setRowAction(null);
    },
  });
  const removeMany = trpc.items.removeMany.useMutation({
    onSuccess: refresh,
  });
  const removeOne = trpc.items.remove.useMutation({
    onSuccess: (res) => {
      if ("ok" in res && res.ok === false) {
        alert(res.error);
        return;
      }
      refresh();
    },
  });

  const selectedRows = sorted.filter((i) => selected.has(i.id));
  const batchCount = selectedRows.length;
  const actionIds = rowAction ? [rowAction.id] : selectedRows.map((i) => i.id);
  const actionNames = rowAction ? rowAction.name : `${batchCount} item${batchCount === 1 ? "" : "s"}`;

  const clearRoomParam = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("roomId");
    setSearchParams(next, { replace: true });
    setRoomIds([]);
  };

  const toggleRoomFilter = (id: number) => {
    setRoomIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">All items</h1>
        <span className="font-data text-sm text-muted-foreground">
          {sorted.length} of {items.data?.length ?? 0}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            className="w-full rounded-md border border-input bg-white pl-8 pr-3 py-1.5 text-[13px]"
            placeholder="Search name, room, topic…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <label className="text-[12px] text-muted-foreground">
          Topic
          <select
            className="ml-1.5 rounded-md border border-input bg-white px-2 py-1.5 text-[12px]"
            value={areaId ?? ""}
            onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All topics</option>
            {(areasQuery.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <details className="relative">
          <summary className="cursor-pointer rounded-md border border-input bg-white px-2 py-1.5 text-[12px] list-none">
            Rooms{roomIds.length ? ` (${roomIds.length})` : ""}
          </summary>
          <div className="absolute z-20 mt-1 w-64 max-h-64 overflow-auto rounded-md border border-border bg-white shadow-lg p-2 space-y-1">
            {(roomsQuery.data ?? []).map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={roomIds.includes(r.id)} onChange={() => toggleRoomFilter(r.id)} />
                <span className="truncate">{r.name}</span>
                {r.floor && <span className="text-muted-foreground">{r.floor}</span>}
              </label>
            ))}
            {roomIds.length > 0 && (
              <button type="button" className="text-[11px] text-primary hover:underline" onClick={clearRoomParam}>
                Clear rooms
              </button>
            )}
          </div>
        </details>
        <div className="ml-auto flex gap-1 rounded-md border border-border p-0.5">
          <button className={cn("rounded p-1", view === "list" ? "bg-muted" : "text-muted-foreground")} onClick={() => setView("list")} title="List">
            <ListIcon className="h-3.5 w-3.5" />
          </button>
          <button className={cn("rounded p-1", view === "gallery" ? "bg-muted" : "text-muted-foreground")} onClick={() => setView("gallery")} title="Gallery">
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {batchCount > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent/40 px-3 py-2 text-[13px]">
          <span className="font-medium">{batchCount} selected</span>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => { setMoveRoomId(null); setMoveOpen(true); }}>
            <FolderInput className="h-3.5 w-3.5 mr-1" /> Move
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => { setMoveAreaId(null); setTopicOpen(true); }}>
            <Tag className="h-3.5 w-3.5 mr-1" /> Topic
          </Button>
          <ConfirmDelete
            trigger={
              <Button size="sm" variant="ghost" className="h-7 text-[12px] text-destructive">
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            }
            title={`Delete ${batchCount} item${batchCount === 1 ? "" : "s"}?`}
            description={`Permanently deletes ${batchCount} selected item${batchCount === 1 ? "" : "s"}, their attachments, tasks, relations and photo pins. This cannot be undone.`}
            confirmLabel={`Delete ${batchCount} item${batchCount === 1 ? "" : "s"}`}
            pending={removeMany.isPending}
            onConfirm={() => removeMany.mutate({ ids: selectedRows.map((i) => i.id) })}
          />
          {removeMany.isError && <span className="text-[12px] text-destructive">{removeMany.error.message}</span>}
        </div>
      )}

      <div className="mt-5">
        {view === "gallery" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {sorted.map((it) => (
              <div key={it.id} className="relative">
                <label className="absolute top-2 left-2 z-10">
                  <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleOne(it.id)} />
                </label>
                <Link to={`/items/${it.id}`} className="group block rounded-lg border border-border bg-white p-2 hover:border-primary/50">
                  <Thumb storageKey={it.imageKey} size="lg" />
                  <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">{it.name}</div>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-white overflow-x-auto">
            <table className="ledger-table w-full border-collapse">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                  </th>
                  <th className="w-12" />
                  <SortableTh label="Name" column="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh label="Topic" column="topic" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh label="Location" column="location" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh label="Updated" column="updated" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th className="w-28" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((it) => (
                  <ItemRowView
                    key={it.id}
                    it={it}
                    checked={selected.has(it.id)}
                    onToggle={() => toggleOne(it.id)}
                    onMove={() => setRowAction({ id: it.id, name: it.name, kind: "move" })}
                    onTopic={() => setRowAction({ id: it.id, name: it.name, kind: "topic" })}
                    removePending={removeOne.isPending}
                    onDelete={() => removeOne.mutate({ id: it.id })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sorted.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            No items match these filters.
          </div>
        )}
      </div>

      <Dialog open={moveOpen || rowAction?.kind === "move"} onOpenChange={(o) => { if (!o) { setMoveOpen(false); setRowAction(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {actionNames}</DialogTitle>
          </DialogHeader>
          <RoomPicker value={moveRoomId} onChange={setMoveRoomId} allowNone />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setMoveOpen(false); setRowAction(null); }}>Cancel</Button>
            <Button size="sm" disabled={updateMany.isPending} onClick={() => updateMany.mutate({ ids: actionIds, roomId: moveRoomId })}>
              Move
            </Button>
          </div>
          {updateMany.isError && <p className="text-[12px] text-destructive">{updateMany.error.message}</p>}
        </DialogContent>
      </Dialog>

      <Dialog open={topicOpen || rowAction?.kind === "topic"} onOpenChange={(o) => { if (!o) { setTopicOpen(false); setRowAction(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change topic for {actionNames}</DialogTitle>
          </DialogHeader>
          <AreaPicker value={moveAreaId} onChange={setMoveAreaId} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setTopicOpen(false); setRowAction(null); }}>Cancel</Button>
            <Button size="sm" disabled={updateMany.isPending || moveAreaId == null} onClick={() => moveAreaId != null && updateMany.mutate({ ids: actionIds, areaId: moveAreaId })}>
              Change topic
            </Button>
          </div>
          {updateMany.isError && <p className="text-[12px] text-destructive">{updateMany.error.message}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ItemRowView({
  it,
  checked,
  onToggle,
  onMove,
  onTopic,
  removePending,
  onDelete,
}: {
  it: ItemRow;
  checked: boolean;
  onToggle: () => void;
  onMove: () => void;
  onTopic: () => void;
  removePending: boolean;
  onDelete: () => void;
}) {
  return (
    <tr className={cn("group", it.status === "archived" ? "opacity-50" : "")}>
      <td>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Select ${it.name}`} />
      </td>
      <td>
        <Thumb storageKey={it.imageKey} />
      </td>
      <td>
        <Link to={`/items/${it.id}`} className="font-medium text-primary hover:underline">
          {it.name}
        </Link>
        {it.verificationStatus === "detected" && (
          <span className="ml-1.5 inline-block text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5">needs review</span>
        )}
        {it.status === "archived" && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Archive className="h-3 w-3" /> archived
          </span>
        )}
      </td>
      <td className="text-[12px]">
        {it.areaSlug ? (
          <Link to={`/areas/${it.areaSlug}`} className="text-muted-foreground hover:text-primary hover:underline">
            {it.areaName}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="text-[12px] text-muted-foreground">
        {it.room?.name ?? "—"}
        {it.room?.floor && <span className="ml-1.5 rounded bg-muted px-1.5 text-[10px]">{it.room.floor}</span>}
      </td>
      <td className="font-data text-[11px] text-muted-foreground">{timeAgo(it.updatedAt)}</td>
      <td>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          <button type="button" className="text-[11px] text-primary hover:underline" onClick={onMove}>Move</button>
          <button type="button" className="text-[11px] text-primary hover:underline" onClick={onTopic}>Topic</button>
          <ConfirmDelete
            trigger={
              <button type="button" className="text-muted-foreground hover:text-destructive" title={`Delete ${it.name}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            }
            title={`Delete "${it.name}"?`}
            description="Permanently deletes this item, its attachments, tasks, relations and photo pins."
            confirmLabel="Delete"
            pending={removePending}
            onConfirm={onDelete}
          />
        </div>
      </td>
    </tr>
  );
}
