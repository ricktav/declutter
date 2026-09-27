import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { ItemPicker } from "@/components/ItemPicker";
import { timeAgo } from "@/lib/format";
import { Plus, Sparkles, Loader2, AlertTriangle, X, Archive } from "lucide-react";

const COLUMNS = [
  { status: "new", label: "New" },
  { status: "exploring", label: "Exploring" },
  { status: "converted", label: "Converted" },
  { status: "archived", label: "Archived" },
] as const;

function IdeaCard({ idea }: { idea: NonNullable<ReturnType<typeof useIdeas>>[number] }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => utils.ideas.list.invalidate();

  const update = trpc.ideas.update.useMutation({ onSuccess: invalidate });
  const linkItem = trpc.ideas.linkItem.useMutation({ onSuccess: invalidate });
  const unlinkItem = trpc.ideas.unlinkItem.useMutation({ onSuccess: invalidate });
  const breakdown = trpc.ideas.breakdown.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        invalidate();
        utils.tasks.list.invalidate();
      } else setError(res.error);
    },
    onError: (e) => setError(e.message),
  });

  return (
    <div className="rounded-lg border border-border bg-white p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium">{idea.title}</div>
          {idea.body && (
            <div className="text-[12px] text-muted-foreground mt-0.5 whitespace-pre-wrap">{idea.body}</div>
          )}
        </div>
        <select
          className="rounded border border-input bg-white px-1 py-0.5 text-[11px] shrink-0"
          value={idea.status}
          onChange={(e) => update.mutate({ id: idea.id, status: e.target.value as typeof idea.status })}
        >
          {COLUMNS.map((c) => (
            <option key={c.status} value={c.status}>{c.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-1">
        {idea.area && (
          <span className="micro-label rounded bg-muted px-1.5 py-0.5" style={{ color: idea.area.color }}>
            {idea.area.name}
          </span>
        )}
        {idea.linkedItems.map((li) => (
          <span key={li.id} className="group inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px]">
            <Link to={`/items/${li.id}`} className="hover:underline">{li.name}</Link>
            <button className="opacity-0 group-hover:opacity-100" onClick={() => unlinkItem.mutate({ ideaId: idea.id, itemId: li.id })}>
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>

      {error && (
        <div className="flex gap-1.5 items-start rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <div className="w-36">
          <ItemPicker placeholder="+ link item" onSelect={(sel) => linkItem.mutate({ ideaId: idea.id, itemId: sel.id })} />
        </div>
        <span className="font-data text-[10px] text-muted-foreground">{timeAgo(idea.createdAt)}</span>
        <div className="ml-auto flex items-center gap-1">
          {idea.taskCount > 0 && (
            <span className="font-data text-[10px] text-muted-foreground">{idea.taskCount} tasks</span>
          )}
          <Button size="sm" variant="outline" className="h-6 text-[11px] px-2"
            disabled={breakdown.isPending}
            onClick={() => { setError(null); breakdown.mutate({ id: idea.id }); }}>
            {breakdown.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
            → tasks
          </Button>
          {idea.status !== "archived" && (
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="Archive"
              onClick={() => update.mutate({ id: idea.id, status: "archived" })}>
              <Archive className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function useIdeas() {
  return trpc.ideas.list.useQuery().data;
}

export default function IdeasPage() {
  const ideas = trpc.ideas.list.useQuery();
  const areas = trpc.areas.list.useQuery();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [areaId, setAreaId] = useState<number | "">("");

  const create = trpc.ideas.create.useMutation({
    onSuccess: () => {
      setTitle("");
      setBody("");
      setAreaId("");
      utils.ideas.list.invalidate();
    },
  });

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Ideas</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Collect topics and questions per area. When one is ripe, let AI break it into tasks.
      </p>

      {/* new idea */}
      <div className="mt-5 rounded-lg border border-border bg-white p-3 flex flex-wrap gap-2">
        <input
          className="flex-1 min-w-48 rounded-md border border-input px-3 py-1.5 text-[13px]"
          placeholder="Idea title — e.g. 'consolidate all backups onto the NAS'"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          className="flex-1 min-w-48 rounded-md border border-input px-3 py-1.5 text-[13px]"
          placeholder="details (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <select
          className="rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
          value={areaId}
          onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : "")}
        >
          <option value="">no area</option>
          {(areas.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <Button size="sm" className="h-8 text-[13px]"
          disabled={!title.trim() || create.isPending}
          onClick={() => create.mutate({ title: title.trim(), body: body || undefined, areaId: areaId || undefined })}>
          <Plus className="h-4 w-4 mr-1" /> Add idea
        </Button>
      </div>

      {/* board */}
      <div className="grid md:grid-cols-4 gap-4 mt-6 items-start">
        {COLUMNS.map((col) => {
          const list = (ideas.data ?? []).filter((i) => i.status === col.status);
          return (
            <div key={col.status}>
              <div className="micro-label text-muted-foreground mb-2">
                {col.label} <span className="font-data">({list.length})</span>
              </div>
              <div className="space-y-2">
                {list.map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} />
                ))}
                {list.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border py-4 text-center text-[11px] text-muted-foreground">
                    empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
