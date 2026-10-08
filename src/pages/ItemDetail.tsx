import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useWorkbenchMode } from "@/context/workbenchMode";
import { trpc } from "@/providers/trpc";
import { useAsk } from "@/context/ask";
import { Button } from "@/components/ui/button";
import { ItemPicker } from "@/components/ItemPicker";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { RoomPicker } from "@/components/RoomPicker";
import { RecropDialog } from "@/components/RecropDialog";
import { ChooseFromLibraryDialog } from "@/components/ChooseFromLibraryDialog";
import { ItemRoomPreview } from "@/components/ItemRoomPreview";
import { EnergySection } from "@/components/EnergySection";
import { StorageSection } from "@/components/StorageSection";
import { ZoomOverlay } from "@/components/ZoomOverlay";
import { timeAgo } from "@/lib/format";
import { uploadFile } from "@/lib/upload";
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
  Crop,
  Camera,
  ChevronLeft,
  ChevronRight,
  Images,
  ListTodo,
  Lightbulb,
} from "lucide-react";
import type { AttributeDef } from "@db/schema";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

/** Link to the original, uncropped photo a cutout came from — opens full-size in a new tab. */
function SourceLink({ photoId }: { photoId: number }) {
  const source = trpc.photos.sourcePhoto.useQuery({ photoId });
  if (!source.data?.available || !source.data.url) return null;
  return (
    <a
      href={source.data.url}
      target="_blank"
      rel="noreferrer"
      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary"
      title="View original source photo"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function AttachmentView({
  att,
  onZoom,
}: {
  att: { id: number; kind: string; title: string | null; content: string | null; url: string | null; storageKey: string | null };
  onZoom?: (url: string) => void;
}) {
  const url = trpc.photos.url.useQuery(
    { key: att.storageKey! },
    { enabled: !!att.storageKey && att.kind === "image" },
  );
  const [imgFailed, setImgFailed] = useState(false);
  if (att.kind === "link")
    return (
      <a href={att.url ?? "#"} target="_blank" rel="noreferrer"
        className="flex items-center gap-1.5 text-[13px] text-primary hover:underline">
        <Link2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{att.title ?? att.url}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    );
  if (att.kind === "image" && url.isError)
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
        <span className="font-medium">Image unavailable:</span>{" "}
        {url.error instanceof Error ? url.error.message : "could not resolve storage URL"}
        <div className="mt-0.5 font-data text-[10px] break-all text-amber-700">key: {att.storageKey}</div>
      </div>
    );
  if (att.kind === "image" && imgFailed && url.data?.url)
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900">
        <span className="font-medium">Image failed to load</span> — the file may be missing on disk.
        <a href={url.data.url} target="_blank" rel="noreferrer" className="block mt-0.5 font-data text-[10px] break-all text-amber-700 underline">
          {url.data.url}
        </a>
      </div>
    );
  if (att.kind === "image" && url.data?.url)
    return (
      <div>
        <button
          type="button"
          className="cursor-zoom-in block"
          onClick={() => onZoom?.(url.data!.url!)}
          title="Click to enlarge"
        >
          <img
            src={url.data.url}
            alt={att.title ?? ""}
            className="max-h-80 w-full max-w-xl object-contain rounded border border-border"
            onError={() => setImgFailed(true)}
          />
        </button>
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
  const { mode } = useWorkbenchMode();
  const utils = trpc.useUtils();

  const item = trpc.items.get.useQuery({ id: itemId });
  const history = trpc.events.forEntity.useQuery({ entityType: "item", entityId: itemId });
  const siblings = trpc.items.listByArea.useQuery(
    { areaId: item.data?.areaId ?? 0 },
    { enabled: !!item.data?.areaId },
  );
  const topicAttrKeys = trpc.items.attributeKeysForTopic.useQuery(
    { areaId: item.data?.areaId ?? 0 },
    { enabled: !!item.data?.areaId },
  );
  const siblingIds = (siblings.data ?? []).map((s) => s.id);
  const siblingIndex = siblingIds.indexOf(itemId);
  const prevId = siblingIndex > 0 ? siblingIds[siblingIndex - 1] : null;
  const nextId = siblingIndex >= 0 && siblingIndex < siblingIds.length - 1 ? siblingIds[siblingIndex + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft" && prevId) navigate(`/items/${prevId}`);
      if (e.key === "ArrowRight" && nextId) navigate(`/items/${nextId}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevId, nextId, navigate]);

  const [editingAttrs, setEditingAttrs] = useState(false);
  const [attrDraft, setAttrDraft] = useState<Record<string, string>>({});
  const [newAttrKey, setNewAttrKey] = useState("");
  const [newAttrValue, setNewAttrValue] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newLink, setNewLink] = useState("");
  const [relType, setRelType] = useState("related-to");
  const [newTask, setNewTask] = useState("");
  const [addingTask, setAddingTask] = useState(false);
  const [newIdea, setNewIdea] = useState("");
  const [addingIdea, setAddingIdea] = useState(false);
  const [addingRelation, setAddingRelation] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const locRef = useRef<HTMLElement>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [editingLoc, setEditingLoc] = useState(false);
  const [childName, setChildName] = useState("");
  const [recropId, setRecropId] = useState<number | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const invalidate = () => {
    utils.items.get.invalidate({ id: itemId });
    utils.items.placement.invalidate({ itemId });
    utils.items.listByArea.invalidate();
    utils.areas.list.invalidate();
  };

  const update = trpc.items.update.useMutation({ onSuccess: invalidate });
  const setArchived = trpc.items.setArchived.useMutation({ onSuccess: invalidate });
  const setVerification = trpc.items.setVerification.useMutation({ onSuccess: invalidate });
  const remove = trpc.items.remove.useMutation({
    onSuccess: (res) => {
      if ("ok" in res && res.ok === false) {
        alert(res.error);
        return;
      }
      navigate(-1);
    },
  });
  const attachmentAdded = {
    onSuccess: () => {
      setNewNote("");
      setNewLink("");
      setUploadError(null);
      invalidate();
    },
    onError: (e: { message: string }) => setUploadError(e.message),
  };
  const addPhoto = trpc.photos.add.useMutation(attachmentAdded);
  const addLink = trpc.itemLinks.add.useMutation(attachmentAdded);
  const addingAttachment = addPhoto.isPending || addLink.isPending;
  const removeLink = trpc.itemLinks.remove.useMutation({ onSuccess: invalidate });
  const unlinkPhoto = trpc.photos.unlink.useMutation({ onSuccess: invalidate });
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
  const createIdea = trpc.ideas.create.useMutation({
    onSuccess: () => {
      setNewIdea("");
      setAddingIdea(false);
      invalidate();
      utils.ideas.list.invalidate();
    },
  });
  const setParent = trpc.items.setParent.useMutation({ onSuccess: invalidate });
  const createChild = trpc.items.create.useMutation({ onSuccess: invalidate });

  if (item.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!item.data) return <div className="p-8 text-sm">Item not found.</div>;
  const it = item.data;
  const defs = (it.area?.attributeDefs as AttributeDef[] | null) ?? [];
  const usedAttrKeys = new Set(Object.keys(attrDraft));
  const topicKeyOpts = (topicAttrKeys.data ?? []).filter((r) => !usedAttrKeys.has(r.key));
  const newKeyValOpts = (topicAttrKeys.data ?? []).find((r) => r.key === newAttrKey.trim())?.values ?? [];
  const addAttrField = () => {
    const typed = newAttrKey.trim();
    if (!typed || typed in attrDraft) return;
    setAttrDraft((d) => ({ ...d, [typed]: newAttrValue }));
    setNewAttrKey("");
    setNewAttrValue("");
  };
  const suggested = it.relations.filter((r) => r.status === "suggested");
  const confirmed = it.relations.filter((r) => r.status === "confirmed");
  // photos and links/notes/files live in two tables now; the list shows
  // them together, newest first, as it always did
  const entries = [
    ...it.photos.map((p) => ({
      entry: "photo" as const,
      id: p.id,
      kind: "image" as const,
      title: p.title,
      content: null,
      url: null,
      storageKey: p.storageKey as string | null,
      sourceCaptureId: p.sourceCaptureId,
      createdAt: p.createdAt,
    })),
    ...it.links.map((l) => ({
      entry: "link" as const,
      id: l.id,
      kind: l.kind,
      title: l.title,
      content: l.content,
      url: l.url,
      storageKey: l.storageKey,
      sourceCaptureId: l.sourceCaptureId,
      createdAt: l.createdAt,
    })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  const startEditAttrs = () => {
    const draft: Record<string, string> = {};
    for (const [k, v] of Object.entries(it.attributes ?? {})) draft[k] = String(v);
    for (const d of defs) if (!(d.key in draft)) draft[d.key] = "";
    setAttrDraft(draft);
    setNewAttrKey("");
    setNewAttrValue("");
    setEditingAttrs(true);
  };

  const saveAttrs = () => {
    const cleaned = Object.fromEntries(Object.entries(attrDraft).filter(([, v]) => v !== ""));
    update.mutate({ id: itemId, attributes: cleaned });
    setEditingAttrs(false);
  };

  const startEditLoc = () => {
    if (it.roomId == null) {
      // nothing set yet - default to wherever the adjacent item (same area,
      // one filed just before/after this one) landed, since items are
      // usually filed room-by-room in a batch
      const adjacent = [prevId, nextId]
        .map((sid) => (siblings.data ?? []).find((s) => s.id === sid))
        .find((s) => s && s.roomId != null);
      setRoomId(adjacent?.roomId ?? null);
    } else {
      setRoomId(it.roomId);
    }
    setEditingLoc(true);
  };
  /** The pane's "Pick a room": open the Location editor and bring it into
   * view (it sits further down the column). */
  const pickRoom = () => {
    startEditLoc();
    requestAnimationFrame(() => locRef.current?.scrollIntoView({ block: "center" }));
  };
  const saveLoc = () => {
    update.mutate({
      id: itemId,
      roomId,
      houseId: roomId == null ? it.houseId : undefined,
    });
    setEditingLoc(false);
  };

  const uploadAttachment = async (f: File) => {
    setUploadError(null);
    try {
      const up = await uploadFile(f, "attachments");
      if (up.mimeType.startsWith("image/")) {
        addPhoto.mutate({ itemId, areaId: it.areaId, title: f.name, fileName: up.fileName, storageKey: up.key });
      } else {
        addLink.mutate({ itemId, areaId: it.areaId, kind: "file", title: f.name, fileName: up.fileName, storageKey: up.key, mimeType: up.mimeType });
      }
    } catch (e) {
      setUploadError((e as Error).message);
    }
  };

  return (
    <div key={itemId} className="max-w-5xl mx-auto px-6 py-8">
      {mode === "simple" && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Link to="/focus" className="text-primary hover:underline">← Focus</Link>
          <span>Full Thing page (Advanced depth). Switch to Advanced in the sidebar to keep this layout.</span>
        </div>
      )}
      {it.verificationStatus === "detected" && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
          <span className="text-[13px] text-amber-900">
            Auto-detected, not yet reviewed — confirm it's right, or reject it.
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" className="h-7 text-[12px] bg-amber-700 hover:bg-amber-800"
              onClick={() => setVerification.mutate({ id: itemId, verificationStatus: "confirmed" })}>
              <Check className="h-3.5 w-3.5 mr-1" /> Confirm
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[12px]"
              onClick={() => remove.mutate({ id: itemId })}>
              <X className="h-3.5 w-3.5 mr-1" /> Reject
            </Button>
          </div>
        </div>
      )}
      {/* header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-muted-foreground flex items-center gap-2">
            <Link to={`/areas/${it.area?.slug}`} className="hover:underline">
              {it.area?.name}
            </Link>{" "}
            / item #{it.id}
            {it.status === "archived" && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Archive className="h-3 w-3" /> Archived
              </span>
            )}
          </div>
          <input
            className="text-2xl font-semibold tracking-tight bg-transparent outline-none border-b border-transparent focus:border-input w-full mt-0.5"
            defaultValue={it.name}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== it.name)
                update.mutate({ id: itemId, name: e.target.value.trim() });
            }}
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
          <div className="flex rounded-md border border-input overflow-hidden mr-1" title="Prev/next item in this area (← / →)">
            <button
              className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent border-r border-input"
              disabled={!prevId}
              onClick={() => prevId && navigate(`/items/${prevId}`)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
              disabled={!nextId}
              onClick={() => nextId && navigate(`/items/${nextId}`)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <Button size="sm" variant="outline" className="h-8 text-[12px]"
            onClick={() => openAsk("item", it.id, it.name)}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Ask AI
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-[12px]"
            onClick={startEditLoc}>
            <MapPin className="h-3.5 w-3.5 mr-1" /> Move
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-[12px]"
            onClick={() => setArchived.mutate({ id: itemId, archived: it.status !== "archived" })}>
            {it.status === "archived" ? (
              <><ArchiveRestore className="h-3.5 w-3.5 mr-1" /> Restore</>
            ) : (
              <><Archive className="h-3.5 w-3.5 mr-1" /> Archive</>
            )}
          </Button>
          <ConfirmDelete
            trigger={
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            }
            title={`Delete "${it.name}"?`}
            description="Permanently deletes this item, its attachments, tasks, relations and photo pins. This cannot be undone."
            confirmText={it.name}
            confirmLabel="Delete item"
            pending={remove.isPending}
            onConfirm={() => remove.mutate({ id: itemId })}
          />
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
                <span className="min-w-0">
                  <Link to={`/items/${r.otherItemId}`} className="font-medium text-primary hover:underline">
                    {r.otherItemName}
                  </Link>{" "}
                  <span className="font-data text-[11px] text-violet-600">{r.type}</span>
                  {(r as { reason?: string | null }).reason && (
                    <span className="block text-[11px] text-violet-800">
                      {(r as { reason?: string | null }).reason}
                    </span>
                  )}
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

      {/* lead: pictures first, then where it sits in the room (if placed) */}
      <div className="grid md:grid-cols-[1fr_260px] gap-6 mt-6 items-start">
        <section
          className={`rounded-lg border-2 bg-white p-4 transition-colors ${dragOver ? "border-primary border-dashed" : "border-border"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) uploadAttachment(f);
            else {
              const t = e.dataTransfer.getData("text");
              if (t) addLink.mutate({ itemId, areaId: it.areaId, kind: "link", url: t, title: t });
            }
          }}
        >
          <div className="flex items-center mb-2">
            <h2 className="micro-label text-muted-foreground">Documents & links</h2>
            <span className="micro-label text-muted-foreground/60 ml-2">drop files here</span>
            <input ref={fileRef} type="file" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAttachment(f);
                e.target.value = "";
              }} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadAttachment(f);
                e.target.value = "";
              }} />
            <Button size="sm" variant="ghost" className="h-6 text-[11px] ml-auto"
              onClick={() => cameraRef.current?.click()}
              disabled={addingAttachment}
              title="Take a photo — another angle, a label, a serial number">
              <Camera className="h-3 w-3 mr-1" />
              snap
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]"
              onClick={() => fileRef.current?.click()}
              disabled={addingAttachment}>
              {addingAttachment ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <ImagePlus className="h-3 w-3 mr-1" />}
              file
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]"
              onClick={() => setLibraryOpen(true)}
              title="Crop a photo already in the inbox">
              <Images className="h-3 w-3 mr-1" />
              library
            </Button>
          </div>
          {uploadError && (
            <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[12px] text-amber-900">
              {uploadError}
            </div>
          )}
          <div className="space-y-2.5">
            {entries.length === 0 && (
              <div className="text-[13px] text-muted-foreground">
                Nothing attached. Drop a photo, paste a link or write a note.
              </div>
            )}
            {entries.map((a) => (
              <div key={`${a.entry}-${a.id}`} className="group flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <AttachmentView att={a} onZoom={setLightboxUrl} />
                  <div className="font-data text-[10px] text-muted-foreground">{timeAgo(a.createdAt)}</div>
                </div>
                {a.kind === "image" && a.sourceCaptureId && (
                  <>
                    <SourceLink photoId={a.id} />
                    <button
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary"
                      title="Re-crop from original photo"
                      onClick={() => setRecropId(a.id)}
                    >
                      <Crop className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                {a.entry === "photo" ? (
                  <ConfirmDelete
                    trigger={
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive disabled:opacity-100"
                        title="Unlink this photo from the item - it stays in the Photos pool"
                        disabled={unlinkPhoto.isPending}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    }
                    title="Unlink this photo?"
                    description="The photo stays in the Photos pool; it is only removed from this Thing."
                    confirmLabel="Unlink"
                    pending={unlinkPhoto.isPending}
                    onConfirm={() => unlinkPhoto.mutate({ id: a.id })}
                  />
                ) : (
                  <ConfirmDelete
                    trigger={
                      <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    }
                    title={`Delete ${a.kind === "note" ? "note" : "link"}?`}
                    description="This will be permanently removed."
                    confirmLabel="Delete"
                    pending={removeLink.isPending}
                    onConfirm={() => removeLink.mutate({ id: a.id })}
                  />
                )}
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
                    addLink.mutate({ itemId, areaId: it.areaId, kind: "note", content: newNote.trim() });
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
                    addLink.mutate({ itemId, areaId: it.areaId, kind: "link", url: newLink.trim(), title: newLink.trim() });
                }} />
            </div>
          </div>
        </section>

        {it.roomId != null && it.pos != null && <ItemRoomPreview roomId={it.roomId} itemId={it.id} />}
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        {/* left column */}
        <div className="space-y-6">
          {/* attributes - collapses to a single add-button when empty */}
          {Object.entries(it.attributes ?? {}).length === 0 && !editingAttrs ? (
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border px-4 py-2 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
              onClick={startEditAttrs}
            >
              <Plus className="h-3.5 w-3.5" /> Add attribute
            </button>
          ) : (
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
                    <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => { setEditingAttrs(false); setNewAttrKey(""); setNewAttrValue(""); }}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
              {!editingAttrs ? (
                <div className="divide-y divide-border">
                  {Object.entries(it.attributes ?? {}).map(([k, v]) => (
                    <div key={k} className="flex py-1.5 text-[13px]">
                      <span className="w-36 shrink-0 text-muted-foreground">
                        {defs.find((d) => d.key === k)?.label ?? k}
                      </span>
                      <span className="font-data">
                        {k === "storage_gb" || k === "storage_free_gb" || k === "mount_point" ? (
                          <Link to={`/storage?item=${it.id}`} className="text-primary hover:underline">
                            {String(v)}
                          </Link>
                        ) : (
                          String(v)
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(attrDraft).map(([k, v]) => {
                    const valListId = `attr-val-${itemId}-${k}`;
                    const valOpts = (topicAttrKeys.data ?? []).find((r) => r.key === k)?.values ?? [];
                    return (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-36 shrink-0 text-[12px] text-muted-foreground truncate">
                        {defs.find((d) => d.key === k)?.label ?? k}
                      </span>
                      <input
                        className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                        list={valOpts.length ? valListId : undefined}
                        autoComplete="off"
                        value={v}
                        onChange={(e) => setAttrDraft((d) => ({ ...d, [k]: e.target.value }))}
                      />
                      {valOpts.length > 0 && (
                        <datalist id={valListId}>
                          {valOpts.map((opt) => (
                            <option key={opt.value} value={opt.value} />
                          ))}
                        </datalist>
                      )}
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
                    );
                  })}
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      className="w-36 rounded border border-input px-2 py-1 text-[13px]"
                      list={topicKeyOpts.length ? `attr-key-${itemId}` : undefined}
                      autoComplete="off"
                      placeholder="new key"
                      value={newAttrKey}
                      onChange={(e) => setNewAttrKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addAttrField(); }}
                    />
                    {topicKeyOpts.length > 0 && (
                      <datalist id={`attr-key-${itemId}`}>
                        {topicKeyOpts.map((opt) => (
                          <option key={opt.key} value={opt.key} />
                        ))}
                      </datalist>
                    )}
                    <input
                      className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                      list={newKeyValOpts.length ? `attr-new-val-${itemId}` : undefined}
                      autoComplete="off"
                      placeholder="value"
                      value={newAttrValue}
                      onChange={(e) => setNewAttrValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addAttrField(); }}
                    />
                    {newKeyValOpts.length > 0 && (
                      <datalist id={`attr-new-val-${itemId}`}>
                        {newKeyValOpts.map((opt) => (
                          <option key={opt.value} value={opt.value} />
                        ))}
                      </datalist>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-[11px]"
                      disabled={!newAttrKey.trim() || newAttrKey.trim() in attrDraft}
                      onClick={addAttrField}>
                      <Plus className="h-3 w-3 mr-0.5" /> field
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* relations - collapses to a single add-button when empty */}
          {confirmed.length === 0 && !addingRelation ? (
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border px-4 py-2 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
              onClick={() => setAddingRelation(true)}
            >
              <Link2 className="h-3.5 w-3.5" /> Add relation
            </button>
          ) : (
            <section className="rounded-lg border border-border bg-white p-4">
              <div className="flex items-center mb-2">
                <h2 className="micro-label text-muted-foreground">Relations</h2>
                {confirmed.length === 0 && (
                  <button
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    onClick={() => setAddingRelation(false)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {confirmed.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-[13px]">
                    <span className="font-data text-[11px] rounded bg-muted px-1.5 py-0.5">{r.type}</span>
                    <span className="text-muted-foreground">{r.direction === "out" ? "→" : "←"}</span>
                    <Link to={`/items/${r.otherItemId}`} className="text-primary hover:underline">
                      {r.otherItemName}
                    </Link>
                    <ConfirmDelete
                      trigger={
                        <button className="ml-auto text-muted-foreground hover:text-destructive">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      }
                      title="Remove this relation?"
                      description={`Unlink ${r.otherItemName} (${r.type}).`}
                      confirmLabel="Unlink"
                      pending={removeRelation.isPending}
                      onConfirm={() => removeRelation.mutate({ id: r.id })}
                    />
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
          )}

          <StorageSection itemId={it.id} role={String(it.attributes?.role ?? "")} />
          <EnergySection itemId={it.id} />

          {/* location: house → floor → room (areas are the topic, not the place) */}
          <section ref={locRef} className="rounded-lg border border-border bg-white p-4">
            <div className="flex items-center mb-2">
              <h2 className="micro-label text-muted-foreground">Location</h2>
              {!editingLoc ? (
                <Button size="sm" variant="ghost" className="h-6 text-[11px] ml-auto" onClick={startEditLoc}>
                  Edit
                </Button>
              ) : (
                <Button size="sm" className="h-6 text-[11px] ml-auto" onClick={saveLoc}>Save</Button>
              )}
            </div>
            {!editingLoc ? (
              <div className="text-[13px] space-y-0.5">
                {it.room ? (
                  <span className="text-[13px]">
                    <Link to={`/items?roomId=${it.room.id}`} className="hover:underline">{it.room.name}</Link>
                    {it.room.floor && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">{it.room.floor}</span>}
                    {it.room.hasGeometry && <Link to={`/rooms/${it.room.id}`} className="ml-2 text-[11px] text-muted-foreground hover:underline">open plan</Link>}
                  </span>
                ) : it.house ? (
                  <span className="text-[13px] text-muted-foreground">Unplaced in {it.house.name}</span>
                ) : (
                  <span className="text-[13px] text-muted-foreground">No location</span>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <RoomPicker value={roomId} onChange={setRoomId} allowNone autoFocus houseId={it.houseId ?? undefined} />
                <p className="text-[10px] text-muted-foreground">
                  Area = what the thing is (computers). This = where it physically is.
                </p>
              </div>
            )}
          </section>

          {/* sub-objects: set → mouse, cupboard → shelf, … (nesting) */}
          <section className="rounded-lg border border-border bg-white p-4">
            <h2 className="micro-label text-muted-foreground mb-2">
              Sub-objects {it.children.length > 0 && `(${it.children.length})`}
            </h2>
            {it.children.length === 0 && (
              <div className="text-[13px] text-muted-foreground">None — parts, accessories or contents live here.</div>
            )}
            <div className="space-y-1">
              {it.children.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[13px] group">
                  <Link to={`/items/${c.id}`} className="text-primary hover:underline flex-1 truncate">
                    {c.name}
                  </Link>
                  <ConfirmDelete
                    trigger={
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                        title="Detach (does not delete the sub-object)"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    }
                    title={`Detach “${c.name}”?`}
                    description="It stays in the inventory; it is only unlinked as a sub-object."
                    confirmLabel="Unlink"
                    pending={setParent.isPending}
                    onConfirm={() => setParent.mutate({ id: c.id, parentId: null })}
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-1.5 mt-2">
              <input
                className="flex-1 rounded border border-input px-2 py-1 text-[12px]"
                placeholder="new sub-object (e.g. mouse, monitor)…"
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && childName.trim()) {
                    createChild.mutate({
                      areaId: it.areaId,
                      name: childName.trim(),
                      parentId: it.id,
                      roomId: it.roomId,
                      houseId: it.houseId,
                    });
                    setChildName("");
                  }
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={!childName.trim() || createChild.isPending}
                onClick={() => {
                  createChild.mutate({
                    areaId: it.areaId,
                    name: childName.trim(),
                    parentId: it.id,
                    roomId: it.roomId,
                    houseId: it.houseId,
                  });
                  setChildName("");
                }}
              >
                <Plus className="h-3 w-3 mr-0.5" /> add
              </Button>
            </div>
          </section>
        </div>

        {/* right column: placement first, then add task / add idea */}
        <div className="space-y-6">
          <PlacementPane itemId={it.id} onPickRoom={pickRoom} />

          {/* tasks - collapses to a single add-button when empty, to avoid a
              permanently-empty card taking up space on most items */}
          {it.tasks.length === 0 && !addingTask ? (
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border px-4 py-2 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
              onClick={() => setAddingTask(true)}
            >
              <ListTodo className="h-3.5 w-3.5" /> Add task
            </button>
          ) : (
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="micro-label text-muted-foreground mb-2">Tasks</h2>
              <div className="space-y-1">
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
                  autoFocus={addingTask && it.tasks.length === 0}
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onBlur={() => { if (!newTask.trim() && it.tasks.length === 0) setAddingTask(false); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTask.trim())
                      createTask.mutate({ title: newTask.trim(), itemId: it.id, areaId: it.areaId });
                  }} />
              </div>
            </section>
          )}

          {/* ideas - same collapse pattern; "add" here quick-creates a new
              idea already linked to this item (linking an *existing* idea
              is done from the Ideas page itself) */}
          {it.ideas.length === 0 && !addingIdea ? (
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border px-4 py-2 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground hover:border-foreground/30"
              onClick={() => setAddingIdea(true)}
            >
              <Lightbulb className="h-3.5 w-3.5" /> Add idea
            </button>
          ) : (
            <section className="rounded-lg border border-border bg-white p-4">
              <h2 className="micro-label text-muted-foreground mb-2">Linked ideas</h2>
              <div className="space-y-1">
                {it.ideas.map((idea) => (
                  <div key={idea.id} className="text-[13px]">
                    <Link to="/ideas" className="text-primary hover:underline">{idea.title}</Link>
                    <span className="micro-label text-muted-foreground ml-2">{idea.status}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-3">
                <input className="flex-1 rounded border border-input px-2 py-1 text-[13px]"
                  placeholder="capture an idea about this item…"
                  autoFocus={addingIdea && it.ideas.length === 0}
                  value={newIdea}
                  onChange={(e) => setNewIdea(e.target.value)}
                  onBlur={() => { if (!newIdea.trim() && it.ideas.length === 0) setAddingIdea(false); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newIdea.trim())
                      createIdea.mutate({ title: newIdea.trim(), areaId: it.areaId, itemIds: [it.id] });
                  }} />
              </div>
            </section>
          )}
        </div>
      </div>

      {/* history - at the bottom; useful for audit, not something you need
          while actively working on an item */}
      <section className="mt-6 rounded-lg border border-border bg-white p-4">
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

      <RecropDialog photoId={recropId} open={recropId != null} onClose={() => setRecropId(null)} />
      <ChooseFromLibraryDialog itemId={itemId} open={libraryOpen} onClose={() => setLibraryOpen(false)} />
      <ZoomOverlay open={!!lightboxUrl} onClose={() => setLightboxUrl(null)} title={it.name}>
        {lightboxUrl && (
          <img src={lightboxUrl} alt="" draggable={false} className="max-w-full max-h-full object-contain rounded" />
        )}
      </ZoomOverlay>
    </div>
  );
}

/** Where the Thing is placed, and where it is not yet: pinned in a photo,
 * on its room's 2D plan, and in 3D. Plan and 3D are one fact (roomId + pos);
 * 3D additionally needs the room's walls or its width and depth. Each gap
 * gets its direct action. */
function PlacementPane({ itemId, onPickRoom }: { itemId: number; onPickRoom: () => void }) {
  // "always": coming back from Annotate or the plan must show the new pin or
  // position, even when the cached answer is still within staleTime
  const placement = trpc.items.placement.useQuery({ itemId }, { refetchOnMount: "always" });
  return (
    <section className="rounded-lg border border-border bg-white p-4">
      <h2 className="micro-label text-muted-foreground mb-2">Placement</h2>
      {placement.isLoading ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading placement…
        </div>
      ) : placement.isError || !placement.data ? (
        <div className="text-[13px] text-amber-800">Could not load placement: {placement.error?.message ?? "unknown error"}</div>
      ) : (
        <PlacementRows p={placement.data} onPickRoom={onPickRoom} />
      )}
    </section>
  );
}

type PlacementData = inferRouterOutputs<AppRouter>["items"]["placement"];

/** Room photos offered as pin canvases in the pane; the rest live on /photos. */
const PANE_ROOM_PHOTOS_MAX = 6;

function PlacementRows({ p, onPickRoom }: { p: PlacementData; onPickRoom: () => void }) {
  const utils = trpc.useUtils();
  const removePin = trpc.pins.remove.useMutation({
    onSuccess: () => {
      utils.items.placement.invalidate();
      utils.pins.listForItem.invalidate();
    },
  });
  const room = p.roomName ?? (p.roomId != null ? `room #${p.roomId}` : null);
  const canvases = p.roomPhotos.filter((r) => !r.isCutout);
  const shown = canvases.slice(0, PANE_ROOM_PHOTOS_MAX);
  const in3d = p.onPlan && (p.roomHasGeometry || p.roomHasDimensions);
  const actionLink = "text-[12px] text-primary hover:underline";

  return (
    <div className="space-y-3">
      {/* 1. Photo */}
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-1">
          <Camera className="h-3.5 w-3.5" /> Photo
        </div>
        {p.pins.length > 0 ? (
          <>
            <div className="text-[13px]">Seen in {p.pins.length} photo{p.pins.length === 1 ? "" : "s"}</div>
            <div className="mt-1 space-y-1">
              {p.pins.map((pin) => (
                <div key={pin.pinId} className="text-[13px] flex items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Link to={`/annotate/${pin.photoId}`} className="text-primary hover:underline">
                    {pin.title ?? `photo #${pin.photoId}`}
                  </Link>
                  {pin.label && <span className="text-muted-foreground text-[11px]">as “{pin.label}”</span>}
                  {pin.camera ? (
                    <span className="text-[11px] text-violet-700" title="This photo stands on its room's plan as a camera">
                      · on the plan
                    </span>
                  ) : pin.roomId != null && !pin.isCrop ? (
                    <Link
                      to={`/rooms/${pin.roomId}?placePhoto=${pin.photoId}`}
                      className="text-[11px] text-primary hover:underline"
                      title="Stand this photo on its room's plan, looking where it was taken"
                    >
                      Place
                    </Link>
                  ) : null}
                  <ConfirmDelete
                    trigger={
                      <button
                        type="button"
                        className="ml-auto text-muted-foreground hover:text-destructive"
                        title="Unlink this pin"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    }
                    title="Unlink this pin?"
                    description={`Remove the pin on “${pin.title ?? `photo #${pin.photoId}`}”. The photo stays.`}
                    confirmLabel="Unlink"
                    pending={removePin.isPending}
                    onConfirm={() => removePin.mutate({ id: pin.pinId })}
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="text-[13px] text-muted-foreground">Not pinned in a photo yet</div>
            {p.roomId != null &&
              (shown.length > 0 ? (
                <div className="mt-1">
                  <div className="text-[12px] mb-1">Pin in a photo of {room}</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {shown.map((ph) => (
                      <RoomPhotoTile key={ph.photoId} photo={ph} itemId={p.itemId} />
                    ))}
                  </div>
                  {canvases.length > shown.length && (
                    <Link to={`/photos?room=${p.roomId}`} className={`${actionLink} mt-1 inline-block`}>
                      {canvases.length - shown.length} more in Photos
                    </Link>
                  )}
                </div>
              ) : (
                <div className="mt-0.5 text-[12px]">
                  No photo of {room} yet ·{" "}
                  <Link to={`/photos?room=${p.roomId}`} className={actionLink}>Photos</Link>
                </div>
              ))}
          </>
        )}
      </div>

      {/* 2. 2D plan */}
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-1">
          <MapPin className="h-3.5 w-3.5" /> 2D plan
        </div>
        {p.parentId != null ? (
          // a Thing inside another has no box of its own: the host says where it is
          <div className="text-[13px]">
            Inside{" "}
            <Link to={`/items/${p.parentId}`} className={actionLink}>
              {p.parentName ?? `Thing #${p.parentId}`}
            </Link>{" "}
            · placed with it
          </div>
        ) : p.roomId == null ? (
          <div className="text-[13px] text-muted-foreground">
            Give it a room first ·{" "}
            <button type="button" className={actionLink} onClick={onPickRoom}>Pick a room</button>
          </div>
        ) : p.onPlan ? (
          <div className="text-[13px]">
            Placed on the plan of {room} ·{" "}
            <Link to={`/rooms/${p.roomId}`} className={actionLink}>Open plan</Link>
          </div>
        ) : !p.roomHasPlan ? (
          // no width and depth: the 2D plan is 0x0, nothing to click on; the
          // room page has the form to size it
          <div className="text-[13px] text-muted-foreground">
            Size or scan the room first ·{" "}
            <Link to={`/rooms/${p.roomId}`} className={actionLink}>Open {room}</Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Not on the plan yet
            <Button asChild size="sm" variant="outline" className="h-6 text-[11px]">
              <Link to={`/rooms/${p.roomId}?placeItem=${p.itemId}`}>Place on the plan</Link>
            </Button>
          </div>
        )}
      </div>

      {/* 3. 3D: the same fact as the plan, plus the room's shape */}
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-1">
          <Images className="h-3.5 w-3.5" /> 3D
        </div>
        <div className={`text-[13px] ${in3d || p.parentId != null ? "" : "text-muted-foreground"}`}>
          {p.parentId != null
            ? `With ${p.parentName ?? `Thing #${p.parentId}`}`
            : in3d
            ? "Visible in 3D"
            : p.onPlan
              ? "Scan or size the room to see it in 3D"
              : "Appears once it is on the plan"}
        </div>
      </div>
    </div>
  );
}

function RoomPhotoTile({ photo, itemId }: { photo: PlacementData["roomPhotos"][number]; itemId: number }) {
  const url = trpc.photos.url.useQuery({ key: photo.storageKey });
  const title = photo.title ?? `photo #${photo.photoId}`;
  return (
    <Link
      to={`/annotate/${photo.photoId}?itemId=${itemId}&back=item`}
      title={`Pin in ${title}`}
      className="group block rounded border border-border overflow-hidden hover:border-primary"
    >
      <div className="aspect-square bg-muted">
        {url.data?.url && <img src={url.data.url} alt="" loading="lazy" className="h-full w-full object-cover" />}
      </div>
      <div className="truncate px-1 py-0.5 text-[10px] text-muted-foreground group-hover:text-primary">{title}</div>
    </Link>
  );
}
