import { useMemo, useState } from "react";
import { useParams, Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAsk } from "@/context/ask";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { timeAgo } from "@/lib/format";
import { Plus, Sparkles, Archive, Trash2 } from "lucide-react";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { useNavigate } from "react-router";
import type { AttributeDef } from "@db/schema";

function AddItemDialog({ areaId, defs }: { areaId: number; defs: AttributeDef[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const utils = trpc.useUtils();
  const create = trpc.items.create.useMutation({
    onSuccess: () => {
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
      setOpen(false);
      setName("");
      setDescription("");
      setAttrs({});
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 text-[13px]">
          <Plus className="h-4 w-4 mr-1" /> Add item
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New item</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input
            className="w-full rounded-md border border-input px-3 py-2 text-sm"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="w-full rounded-md border border-input px-3 py-2 text-sm min-h-[60px]"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {defs.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {defs.map((d) => (
                <label key={d.key} className="block">
                  <span className="micro-label text-muted-foreground">{d.label}</span>
                  {d.type === "select" ? (
                    <select
                      className="mt-0.5 w-full rounded-md border border-input px-2 py-1.5 text-[13px] bg-white"
                      value={attrs[d.key] ?? ""}
                      onChange={(e) => setAttrs((a) => ({ ...a, [d.key]: e.target.value }))}
                    >
                      <option value="">—</option>
                      {(d.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={d.type === "number" ? "number" : "text"}
                      className="mt-0.5 w-full rounded-md border border-input px-2 py-1.5 text-[13px]"
                      value={attrs[d.key] ?? ""}
                      onChange={(e) => setAttrs((a) => ({ ...a, [d.key]: e.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  areaId,
                  name: name.trim(),
                  description: description || undefined,
                  attributes: Object.fromEntries(
                    Object.entries(attrs).filter(([, v]) => v !== ""),
                  ),
                })
              }
            >
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function AreaView() {
  const { slug } = useParams<{ slug: string }>();
  const { openAsk } = useAsk();
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const navigate = useNavigate();

  const area = trpc.areas.get.useQuery({ slug: slug! }, { enabled: !!slug });
  const utils = trpc.useUtils();
  const removeArea = trpc.areas.remove.useMutation({
    onSuccess: () => {
      utils.areas.list.invalidate();
      navigate("/");
    },
  });
  const removeItem = trpc.items.remove.useMutation({
    onSuccess: (res) => {
      if ("ok" in res && res.ok === false) {
        alert(res.error);
        return;
      }
      utils.items.listByArea.invalidate();
      utils.areas.list.invalidate();
    },
  });
  const itemsList = trpc.items.listByArea.useQuery(
    { areaId: area.data?.id ?? 0, includeArchived: showArchived },
    { enabled: !!area.data },
  );

  // columns: from attributeDefs if present, else union of keys seen
  const columns = useMemo(() => {
    const defs = area.data?.attributeDefs as AttributeDef[] | null;
    if (defs?.length) return defs;
    const keys = new Map<string, string>();
    for (const it of itemsList.data ?? []) {
      for (const k of Object.keys(it.attributes ?? {})) if (!keys.has(k)) keys.set(k, k);
    }
    return [...keys.entries()].map(([key, label]) => ({ key, label, type: "text" as const }));
  }, [area.data, itemsList.data]);

  const filtered = (itemsList.data ?? []).filter(
    (i) => !q || i.name.toLowerCase().includes(q.toLowerCase()),
  );

  if (area.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!area.data) return <div className="p-8 text-sm">Area not found.</div>;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-sm" style={{ background: area.data.color }} />
        <h1 className="text-2xl font-semibold tracking-tight">{area.data.name}</h1>
        <span className="font-data text-sm text-muted-foreground">
          {filtered.length} item{filtered.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[13px]"
            onClick={() => openAsk("area", area.data!.id, area.data!.name)}
          >
            <Sparkles className="h-4 w-4 mr-1" /> Ask AI
          </Button>
          <AddItemDialog areaId={area.data.id} defs={(area.data.attributeDefs as AttributeDef[]) ?? []} />
          <ConfirmDelete
            trigger={
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            }
            title={`Delete area "${area.data.name}"?`}
            description={`Permanently deletes this area and ALL ${itemsList.data?.length ?? 0} item(s) in it — attachments, tasks, relations, everything. This cannot be undone.`}
            confirmText={area.data.name}
            confirmLabel="Delete area"
            pending={removeArea.isPending}
            onConfirm={() => removeArea.mutate({ id: area.data!.id })}
          />
        </div>
      </div>
      {area.data.description && (
        <p className="text-sm text-muted-foreground mt-1">{area.data.description}</p>
      )}

      <div className="flex items-center gap-3 mt-5">
        <input
          className="w-64 rounded-md border border-input bg-white px-3 py-1.5 text-[13px]"
          placeholder="Filter by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          show archived
        </label>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-white overflow-x-auto">
        <table className="ledger-table w-full border-collapse">
          <thead>
            <tr>
              <th>Name</th>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th>Updated</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((it) => (
              <tr key={it.id} className={`group ${it.status === "archived" ? "opacity-50" : ""}`}>
                <td>
                  <Link to={`/items/${it.id}`} className="font-medium text-primary hover:underline">
                    {it.name}
                  </Link>
                  {it.status === "archived" && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                      <Archive className="h-3 w-3" /> archived
                    </span>
                  )}
                </td>
                {columns.map((c) => (
                  <td key={c.key} className="font-data text-[12px]">
                    {String(it.attributes?.[c.key] ?? "")}
                  </td>
                ))}
                <td className="font-data text-[11px] text-muted-foreground">{timeAgo(it.updatedAt)}</td>
                <td>
                  <ConfirmDelete
                    trigger={
                      <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    }
                    title={`Delete "${it.name}"?`}
                    description="Permanently deletes this item, its attachments, tasks, relations and photo pins."
                    confirmLabel="Delete"
                    pending={removeItem.isPending}
                    onConfirm={() => removeItem.mutate({ id: it.id })}
                  />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} className="text-center text-muted-foreground py-8">
                  No items yet — add one, or capture something via the inbox.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
