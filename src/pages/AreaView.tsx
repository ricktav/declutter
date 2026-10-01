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
import { Plus, Sparkles, Archive, Trash2, Pencil, LayoutGrid, List as ListIcon } from "lucide-react";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { Thumb } from "@/components/Thumb";
import { useNavigate } from "react-router";
import type { AttributeDef } from "@db/schema";
import { AREA_ICONS, AREA_COLORS } from "@/lib/areaStyle";
import { cn } from "@/lib/utils";
import type { Area } from "@db/schema";

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function EditAreaDialog({ area }: { area: Area }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(area.name);
  const [slug, setSlug] = useState(area.slug);
  const [slugTouched, setSlugTouched] = useState(true);
  const [icon, setIcon] = useState(area.icon);
  const [color, setColor] = useState(area.color);
  const [description, setDescription] = useState(area.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const update = trpc.areas.update.useMutation({
    onSuccess: (updated) => {
      utils.areas.list.invalidate();
      utils.areas.get.invalidate();
      utils.items.listByArea.invalidate();
      setOpen(false);
      if (updated && updated.slug !== area.slug) navigate(`/areas/${updated.slug}`, { replace: true });
    },
    onError: (e) => setError(e.message),
  });

  const slugValid = /^[a-z0-9-]+$/.test(slug);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 w-8 p-0">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit topic</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <input
            className="w-full rounded-md border border-input px-3 py-2 text-sm"
            placeholder="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
            autoFocus
          />
          <div>
            <input
              className="w-full rounded-md border border-input px-3 py-2 text-sm font-data"
              placeholder="slug-used-in-url"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              URL-fragment (a-z, 0-9, koppeltekens). Alleen wijzigen als je de URL van dit overzicht wilt veranderen — naam en items blijven gewoon werken.
            </p>
            {!slugValid && slug.length > 0 && (
              <p className="mt-1 text-[11px] text-destructive">Slug mag alleen kleine letters, cijfers en koppeltekens bevatten.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AREA_ICONS.map((i) => (
              <button
                key={i.key}
                type="button"
                title={i.label}
                onClick={() => setIcon(i.key)}
                className={cn(
                  "h-8 w-8 rounded-md border flex items-center justify-center",
                  icon === i.key ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground",
                )}
              >
                <i.icon className="h-4 w-4" />
              </button>
            ))}
            <div className="ml-auto flex gap-1.5">
              {AREA_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-8 w-8 rounded-md border-2",
                    color === c ? "border-foreground" : "border-transparent",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <textarea
            className="w-full rounded-md border border-input px-3 py-2 text-sm min-h-[60px]"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button
              disabled={!name.trim() || !slug.trim() || !slugValid || update.isPending}
              onClick={() =>
                update.mutate({
                  id: area.id,
                  name: name.trim(),
                  slug: slug.trim(),
                  icon,
                  color,
                  description: description || null,
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
  const [view, setView] = useState<"list" | "gallery">("list");
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
  if (!area.data) return <div className="p-8 text-sm">Topic not found.</div>;

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
          <EditAreaDialog area={area.data} />
          <ConfirmDelete
            trigger={
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            }
            title={`Delete topic "${area.data.name}"?`}
            description={`Permanently deletes this topic and ALL ${itemsList.data?.length ?? 0} item(s) in it — attachments, tasks, relations, everything. This cannot be undone.`}
            confirmText={area.data.name}
            confirmLabel="Delete topic"
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
        <div className="ml-auto flex gap-1 rounded-md border border-border p-0.5">
          <button
            className={cn("rounded p-1", view === "list" ? "bg-muted" : "text-muted-foreground")}
            onClick={() => setView("list")}
            title="List"
          >
            <ListIcon className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn("rounded p-1", view === "gallery" ? "bg-muted" : "text-muted-foreground")}
            onClick={() => setView("gallery")}
            title="Gallery"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {view === "gallery" ? (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map((it) => (
            <Link
              key={it.id}
              to={`/items/${it.id}`}
              className={`group rounded-lg border border-border bg-white p-2 hover:border-primary/50 ${it.status === "archived" ? "opacity-50" : ""}`}
            >
              <Thumb storageKey={it.imageKey} size="lg" />
              <div className="mt-1.5 truncate text-[13px] font-medium group-hover:text-primary">{it.name}</div>
              {it.verificationStatus === "detected" && (
                <span className="inline-block text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5">
                  needs review
                </span>
              )}
              {it.status === "archived" && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                  <Archive className="h-3 w-3" /> archived
                </span>
              )}
            </Link>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center text-muted-foreground py-8">
              No items yet — add one, or capture something via the inbox.
            </div>
          )}
        </div>
      ) : (
      <div className="mt-3 rounded-lg border border-border bg-white overflow-x-auto">
        <table className="ledger-table w-full border-collapse">
          <thead>
            <tr>
              <th className="w-12" />
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
                  <Thumb storageKey={it.imageKey} />
                </td>
                <td>
                  <Link to={`/items/${it.id}`} className="font-medium text-primary hover:underline">
                    {it.name}
                  </Link>
                  {it.verificationStatus === "detected" && (
                    <span className="ml-1.5 inline-block text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5">
                      needs review
                    </span>
                  )}
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
                <td colSpan={columns.length + 4} className="text-center text-muted-foreground py-8">
                  No items yet — add one, or capture something via the inbox.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
