import { useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAsk } from "@/context/ask";
import { Button } from "@/components/ui/button";
import { ItemPicker } from "@/components/ItemPicker";
import { fileToBase64, timeAgo } from "@/lib/format";
import {
  Sparkles,
  Archive,
  ArchiveRestore,
  Trash2,
  Plus,
  Link2,
  StickyNote,
  ImagePlus,
  Check,
  X,
  ExternalLink,
  Loader2,
  MapPin,
} from "lucide-react";
import type { AttributeDef } from "@db/schema";

function AttachmentView({ att }: { att: { id: number; kind: string; title: string | null; content: string | null; url: string | null; storageKey: string | null } }) {
  const url = trpc.attachments.url.useQuery(
    { key: att.storageKey! },
    { enabled: !!att.storageKey && att.kind === "image" },
  );
  if (att.kind === "link")
    return (
      <a href={att.url ?? "#"} target="_blank" rel="noreferrer"
        className="flex items-center gap-1.5 text-[13px] text-primary hover:underline">
        <Link2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{att.title ?? att.url}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    );
  if (att.kind === "image" && url.data?.url)
    return (
      <div>
        <a href={url.data.url} target="_blank" rel="noreferrer">
          <img src={url.data.url} alt={att.title ?? ""} className="max-h-40 rounded border border-border" />
        </a>
        <div className="flex items-center gap-2 mt-0.5">
          {att.title && <div className="text-[11px] text-muted-foreground">{att.title}</div>}
          <Link to={`/annotate/${att.id}`}
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
            <MapPin className="h-3 w-3" /> Annotate
          </Link>
        </div>
      </div>
    );
  return (
    <div className="text-[13px] whitespace-pre-wrap">
      <span className="micro-label text-muted-foreground mr-1.5">{att.kind}</span>
      {att.title && <span className="font-medium mr-1.5">{att.title}</span>}
      {att.content}
    </div>
  );
}

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const itemId = Number(id);
  const navigate = useNavigate();
  const { openAsk } = useAsk();
  const utils = trpc.useUtils();

  const item = trpc.items.get.useQuery({ id: itemId });
  const history = trpc.events.forEntity.useQuery({ entityType: "item", entityId: itemId });

  const [editingAttrs, setEditingAttrs] = useState(false);
  const [attrDraft, setAttrDraft] = useState<Record<string, string>>({});
  const [newAttrKey, setNewAttrKey] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newLink, setNewLink] = useState("");
  const [relType, setRelType] = useState("related-to");
  const [newTask, setNewTask] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const invalidate = () => {
    utils.items.get.invalidate({ id: itemId });
    utils.items.listByArea.invalidate();
    utils.areas.list.invalidate();
  };

  const update = trpc.items.update.useMutation({ onSuccess: invalidate });
  const setArchived = trpc.items.setArchived.useMutation({ onSuccess: invalidate });
  const remove = trpc.items.remove.useMutation({ onSuccess: () => navigate(-1) });
  const addAttachment = trpc.attachments.add.useMutation({
    onSuccess: () => {
      setNewNote("");
      setNewLink("");
      setUploadError(null);
      invalidate();
    },
    onError: (e) => setUploadError(e.message),
  });
  const removeAttachment = trpc.attachments.remove.useMutation({ onSuccess: invalidate });
  const addRelation = trpc.items.addRelation.useMutation({ onSuccess: invalidate });
  const resolveRelation = trpc.items.resolveRelation.useMutation({
    onSuccess: () => {
      invalidate();
      utils.events.list.invalidate();
    },
  });
  const removeRelation = trpc.items.removeRelation.useMutation({ onSuccess: invalidate });
  const createTask = trpc.tasks.create.useMutation({
    onSuccess: () => {
      setNewTask("");
      invalidate();
      utils.tasks.list.invalidate();
    },
  });

  if (item.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!item.data) return <div className="p-8 text-sm">Item not found.</div>;
  const it = item.data;
  const defs = (it.area?.attributeDefs as AttributeDef[] | null) ?? [];
  const suggested = it.relations.filter((r) => r.status === "suggested");
  const confirmed = it.relations.filter((r) => r.status === "confirmed");

  const startEditAttrs = () => {
    const draft: Record<string, string> = {};
    for (const [k, v] of Object.entries(it.attributes ?? {})) draft[k] = String(v);
    for (const d of defs) if (!(d.key in draft)) draft[d.key] = "";
    setAttrDraft(draft);
    setEditingAttrs(true);
  };

  const saveAttrs = () => {
    const cleaned = Object.fromEntries(Object.entries(attrDraft).filter(([, v]) => v !== ""));
    update.mutate({ id: itemId, attributes: cleaned });
    setEditingAttrs(false);
  };

  const uploadFile = async (f: File) => {
    const contentBase64 = await fileToBase64(f);
    addAttachment.mutate({
      itemId,
      areaId: it.areaId,
      kind: f.type.startsWith("image/") ? "image" : "file",
      title: f.name,
      fileName: f.name,
      contentBase64,
      mimeType: f.type,
    });
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-muted-foreground">
            <Link to={`/areas/${it.area?.slug}`} className="hover:underline">
              {it.area?.name}
            </Link>{" "}
            / item #{it.id}
          </div>
          <input
            className="text-2xl font-semibold tracking-tight bg-transparent outline-none border-b border-transparent focus:border-input w-full mt-0.5"
            value={it.name}
            onChange={(e) => update.mutate({ id: itemId, name: e.target.value })}
          />
          <textarea
            className="w-full text-sm text-muted-foreground bg-transparent outline-none mt-1 min-h-[40px] resize-y"
            placeholder="Add a description…"
            defaultValue={it.description ?? ""}
            onBlur={(e) => {
              if (e.target.value !== (it.description ?? ""))
                update.mutate({ id: itemId, description: e.target.value });
            }}
          />
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Button size="sm" variant="outline" className="h-8 text-[12px]"
            onClick={() => openAsk("item", it.id, it.name)}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Ask AI
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-[12px]"
            onClick={() => setArchived.mutate({ id: itemId, archived: it.status !== "archived" })}>
            {it.status === "archived" ? (
              <><ArchiveRestore className="h-3.5 w-3.5 mr-1" /> Restore</>
            ) : (
              <><Archive className="h-3.5 w-3.5 mr-1" /> Archive</>
            )}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive"
            onClick={() => {
              if (confirm(`Delete "${it.name}"? This cannot be undone.`)) remove.mutate({ id: itemId });
            }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* suggested relations banner */}
      {suggested.length > 0 && (
        <div className="mt-4 rounded-lg border border-violet-300 bg-violet-50 p-3">
          <div className="micro-label text-violet-700 mb-2">
            AI found {suggested.length} possible connection{suggested.length > 1 ? "s" : ""}
          </div>
          <div className="space-y-1.5">
            {suggested.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[13px]">
                <span>
                  {it.name} <span className="font-data text-[11px] text-violet-600">{r.type}</span>{" "}
                  <Link to={`/items/${r.otherItemId}`} className="font-medium text-primary hover:underline">
                    {r.otherItemName}
                  </Link>
                </span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" className="h-6 text-[11px] px-2"
                    onClick={() => resolveRelation.mutate({ id: r.id, confirm: true })}>
                    <Check className="h-3 w-3 mr-0.5" /> confirm
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2"
                    onClick={() => resolveRelation.mutate({ id: r.id, confirm: false })}>
                    <X className="h-3 w-3 mr-0.5" /> reject
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        {/* left column */}
        <div className="space-y-6">
          {/* attributes */}
          <section className="rounded-lg border border-border bg-white p-4">
            <div className="flex items-center mb-2">
              <h2 className="micro-label text-muted-foreground">Attributes</h2>
              {!editingAttrs ? (
                <Button size="sm" variant="ghost" className="h-6 text-[11px] ml-auto" onClick={startEditAttrs}>
                  Edit
                </Button>
              ) : (
                <div className="ml-auto flex gap-1">
                  <Button size="sm" className="h-6 text-[11px]" onClick={saveAttrs}>Save</Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setEditingAttrs(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
            {!editingAttrs ? (
              <div className="divide-y divide-border">
                {Object.entries(it.attributes ?? {}).length === 0 && (
                  <div className="text-[13px] text-muted-foreground py-2">No attributes yet.</div>
                )}
                {Object.entries(it.attributes ?? {}).map(([k, v]) => (
                  <div key={k} className="flex py-1.5 text-[13px]">
                    <span className="w-36 shrink-0 text-muted-foreground">
                      {defs.find((d) => d.key === k)?.label ?? k}
                    </span>
                    <span className="font-data">{String(v)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(attrDraft).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-36 shrink-0 text-[12px] text-muted-foreground truncate">
                      {defs.find((d) => d.key === k)?.label ?? k}
                    </span>
                    <input
                      className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                      value={v}
                      onChange={(e) => setAttrDraft((d) => ({ ...d, [k]: e.target.value }))}
                    />
                    <button className="text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setAttrDraft((d) => {
                          const c = { ...d };
                          delete c[k];
                          return c;
                        })
                      }>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    className="w-36 rounded border border-input px-2 py-1 text-[13px]"
                    placeholder="new key"
                    value={newAttrKey}
                    onChange={(e) => setNewAttrKey(e.target.value)}
                  />
                  <Button size="sm" variant="outline" className="h-7 text-[11px]"
                    disabled={!newAttrKey.trim() || newAttrKey in attrDraft}
                    onClick={() => {
                      setAttrDraft((d) => ({ ...d, [newAttrKey.trim()]: "" }));
                      setNewAttrKey("");
                    }}>
                    <Plus className="h-3 w-3 mr-0.5" /> field
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* relations */}
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="micro-label text-muted-foreground mb-2">Relations</h2>
            <div className="space-y-1.5">
              {confirmed.length === 0 && (
                <div className="text-[13px] text-muted-foreground">No confirmed relations yet.</div>
              )}
              {confirmed.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[13px]">
                  <span className="font-data text-[11px] rounded bg-muted px-1.5 py-0.5">{r.type}</span>
                  <span className="text-muted-foreground">{r.direction === "out" ? "→" : "←"}</span>
                  <Link to={`/items/${r.otherItemId}`} className="text-primary hover:underline">
                    {r.otherItemName}
                  </Link>
                  <button className="ml-auto text-muted-foreground hover:text-destructive"
                    onClick={() => removeRelation.mutate({ id: r.id })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <select
                className="rounded-md border border-input px-2 py-1.5 text-[12px] bg-white"
                value={relType}
                onChange={(e) => setRelType(e.target.value)}
              >
                {["related-to", "belongs-to", "installed-on", "part-of", "cable-for", "backs-up", "replaces"].map(
                  (t) => (
                    <option key={t} value={t}>{t}</option>
                  ),
                )}
              </select>
              <div className="flex-1">
                <ItemPicker
                  excludeId={it.id}
                  placeholder="link to item…"
                  onSelect={(sel) =>
                    addRelation.mutate({ fromItemId: it.id, toItemId: sel.id, type: relType })
                  }
                />
              </div>
            </div>
          </section>

          {/* history */}
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="micro-label text-muted-foreground mb-2">History</h2>
            <div className="space-y-1">
              {(history.data ?? []).length === 0 && (
                <div className="text-[13px] text-muted-foreground">No recorded events.</div>
              )}
              {(history.data ?? []).map((e) => (
                <div key={e.id} className="flex items-baseline gap-2 text-[12px]">
                  <span className={`micro-label shrink-0 ${e.actor === "ai" ? "text-violet-600" : "text-muted-foreground"}`}>
                    {e.actor}
                  </span>
                  <span className="flex-1">{e.summary}</span>
                  <span className="font-data text-[11px] text-muted-foreground shrink-0">{timeAgo(e.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* right column */}
        <div className="space-y-6">
          {/* attachments */}
          <section
            className={`rounded-lg border-2 bg-white p-4 transition-colors ${dragOver ? "border-primary border-dashed" : "border-border"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) uploadFile(f);
              else {
                const t = e.dataTransfer.getData("text");
                if (t) addAttachment.mutate({ itemId, areaId: it.areaId, kind: "link", url: t, title: t });
              }
            }}
          >
            <div className="flex items-center mb-2">
              <h2 className="micro-label text-muted-foreground">Documents & links</h2>
              <span className="micro-label text-muted-foreground/60 ml-2">drop files here</span>
              <input ref={fileRef} type="file" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadFile(f);
                  e.target.value = "";
                }} />
              <Button size="sm" variant="ghost" className="h-6 text-[11px] ml-auto"
                onClick={() => fileRef.current?.click()}
                disabled={addAttachment.isPending}>
                {addAttachment.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ImagePlus className="h-3 w-3 mr-1" />}
                file
              </Button>
            </div>
            {uploadError && (
              <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900">
                {uploadError}
              </div>
            )}
            <div className="space-y-2.5">
              {it.attachments.length === 0 && (
                <div className="text-[13px] text-muted-foreground">
                  Nothing attached. Drop a photo, paste a link or write a note.
                </div>
              )}
              {it.attachments.map((a) => (
                <div key={a.id} className="group flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <AttachmentView att={a} />
                    <div className="font-data text-[10px] text-muted-foreground">{timeAgo(a.createdAt)}</div>
                  </div>
                  <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    onClick={() => removeAttachment.mutate({ id: a.id })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <StickyNote className="h-4 w-4 text-muted-foreground mt-1.5 shrink-0" />
                <input className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                  placeholder="quick note… (Enter to save)"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newNote.trim())
                      addAttachment.mutate({ itemId, areaId: it.areaId, kind: "note", content: newNote.trim() });
                  }} />
              </div>
              <div className="flex gap-2">
                <Link2 className="h-4 w-4 text-muted-foreground mt-1.5 shrink-0" />
                <input className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                  placeholder="https://… (Enter to save)"
                  value={newLink}
                  onChange={(e) => setNewLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLink.trim())
                      addAttachment.mutate({ itemId, areaId: it.areaId, kind: "link", url: newLink.trim(), title: newLink.trim() });
                  }} />
              </div>
            </div>
          </section>

          {/* tasks */}
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="micro-label text-muted-foreground mb-2">Tasks</h2>
            <div className="space-y-1">
              {it.tasks.length === 0 && (
                <div className="text-[13px] text-muted-foreground">No tasks for this item.</div>
              )}
              {it.tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-[13px]">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    t.status === "done" ? "bg-emerald-500" : t.status === "doing" ? "bg-amber-500" : "bg-muted-foreground/40"
                  }`} />
                  <span className={t.status === "done" ? "line-through text-muted-foreground flex-1" : "flex-1"}>
                    {t.title}
                  </span>
                  <span className="font-data text-[10px] text-muted-foreground">{timeAgo(t.createdAt)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                placeholder="add a task for this item…"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTask.trim())
                    createTask.mutate({ title: newTask.trim(), itemId: it.id, areaId: it.areaId });
                }} />
            </div>
          </section>

          {/* ideas */}
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="micro-label text-muted-foreground mb-2">Linked ideas</h2>
            <div className="space-y-1">
              {it.ideas.length === 0 && (
                <div className="text-[13px] text-muted-foreground">No ideas reference this item yet.</div>
              )}
              {it.ideas.map((idea) => (
                <div key={idea.id} className="text-[13px]">
                  <Link to="/ideas" className="text-primary hover:underline">{idea.title}</Link>
                  <span className="micro-label text-muted-foreground ml-2">{idea.status}</span>
                </div>
              ))}
            </div>
          </section>

          {/* pinned in photos */}
          <PinnedInPhotos itemId={it.id} />
        </div>
      </div>
    </div>
  );
}

function PinnedInPhotos({ itemId }: { itemId: number }) {
  const pins = trpc.annotations.listForItem.useQuery({ itemId });
  const list = (pins.data ?? []).filter((p) => p.status === "confirmed");
  if (!pins.data) return null;
  return (
    <section className="rounded-lg border border-border bg-white p-4">
      <h2 className="micro-label text-muted-foreground mb-2">Seen in photos</h2>
      {list.length === 0 && (
        <div className="text-[13px] text-muted-foreground">
          Not pinned in any photo yet — annotate a photo and link this item.
        </div>
      )}
      <div className="space-y-1">
        {list.map((p) => (
          <div key={p.id} className="text-[13px] flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Link to={`/annotate/${p.attachmentId}`} className="text-primary hover:underline">
              {p.attachment?.title ?? `photo #${p.attachmentId}`}
            </Link>
            {p.label && <span className="text-muted-foreground text-[11px]">as “{p.label}”</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
