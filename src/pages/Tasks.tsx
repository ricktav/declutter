import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { timeAgo, formatDuration, formatClock } from "@/lib/format";
import { Plus, Play, Square, Trash2, CheckCircle2, Circle, Loader } from "lucide-react";

type TaskRow = NonNullable<ReturnType<typeof useTaskList>>[number];
function useTaskList() {
  return trpc.tasks.list.useQuery().data;
}

function TaskCard({ task }: { task: TaskRow }) {
  const utils = trpc.useUtils();
  const invalidate = () => {
    utils.tasks.list.invalidate();
    utils.tasks.runningTimer.invalidate();
  };
  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: invalidate });
  const remove = trpc.tasks.remove.useMutation({ onSuccess: invalidate });
  const startTimer = trpc.tasks.startTimer.useMutation({ onSuccess: invalidate });
  const stopTimer = trpc.tasks.stopTimer.useMutation({ onSuccess: invalidate });

  return (
    <div className="rounded-lg border border-border bg-white p-3 space-y-1.5 group">
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary"
          title={task.status === "done" ? "reopen" : "complete"}
          onClick={() => setStatus.mutate({ id: task.id, status: task.status === "done" ? "todo" : "done" })}
        >
          {task.status === "done" ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <Circle className="h-4 w-4" />
          )}
        </button>
        <span className={`text-[13px] flex-1 ${task.status === "done" ? "line-through text-muted-foreground" : "font-medium"}`}>
          {task.title}
        </span>
        <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
          onClick={() => remove.mutate({ id: task.id })}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {task.notes && <div className="text-[12px] text-muted-foreground pl-6">{task.notes}</div>}
      <div className="flex items-center gap-1.5 pl-6 flex-wrap">
        {task.itemName && task.itemId && (
          <Link to={`/items/${task.itemId}`} className="rounded bg-accent px-1.5 py-0.5 text-[11px] hover:underline">
            {task.itemName}
          </Link>
        )}
        {task.areaName && (
          <span className="micro-label text-muted-foreground rounded bg-muted px-1.5 py-0.5">{task.areaName}</span>
        )}
        <span className="font-data text-[10px] text-muted-foreground">created {timeAgo(task.createdAt)}</span>
        {task.completedAt && (
          <span className="font-data text-[10px] text-emerald-700">done {timeAgo(task.completedAt)}</span>
        )}
        {task.totalSeconds > 0 && (
          <span className="font-data text-[10px] text-sky-700">⏱ {formatDuration(task.totalSeconds)}</span>
        )}
      </div>
      <div className="flex items-center gap-1 pl-6 pt-0.5">
        {task.status !== "done" && (
          <>
            {task.runningLogId ? (
              <Button size="sm" variant="outline" className="h-6 text-[11px] px-2 border-amber-400 text-amber-700"
                onClick={() => stopTimer.mutate({ taskId: task.id })}>
                <Square className="h-3 w-3 mr-1" /> stop
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-6 text-[11px] px-2"
                onClick={() => startTimer.mutate({ taskId: task.id })}>
                <Play className="h-3 w-3 mr-1" /> timer
              </Button>
            )}
            {task.status === "todo" && (
              <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2"
                onClick={() => setStatus.mutate({ id: task.id, status: "doing" })}>
                → doing
              </Button>
            )}
            {task.status === "doing" && (
              <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2"
                onClick={() => setStatus.mutate({ id: task.id, status: "todo" })}>
                → todo
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const COLUMNS = [
  { status: "todo", label: "To do", icon: Circle },
  { status: "doing", label: "Doing", icon: Loader },
  { status: "done", label: "Done", icon: CheckCircle2 },
] as const;

export default function TasksPage() {
  const tasks = trpc.tasks.list.useQuery();
  const running = trpc.tasks.runningTimer.useQuery(undefined, { refetchInterval: 5000 });
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => {
      setTitle("");
      utils.tasks.list.invalidate();
    },
  });

  const elapsed = running.data
    ? Math.max(0, Math.floor((Date.now() - new Date(running.data.startedAt).getTime()) / 1000))
    : 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Tasks come from ideas or items. Timers keep a record of where the time went.
      </p>

      {running.data && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-[13px] font-medium">{running.data.taskTitle}</span>
          <span className="font-data text-[13px] text-amber-800">{formatClock(elapsed)}</span>
          <span className="micro-label text-amber-700 ml-auto">recording</span>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <input
          className="flex-1 rounded-md border border-input bg-white px-3 py-1.5 text-[13px]"
          placeholder="New task… (Enter)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && title.trim()) create.mutate({ title: title.trim() });
          }}
        />
        <Button size="sm" className="h-8 text-[13px]" disabled={!title.trim() || create.isPending}
          onClick={() => create.mutate({ title: title.trim() })}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mt-6 items-start">
        {COLUMNS.map((col) => {
          const list = (tasks.data ?? []).filter((t) => t.status === col.status);
          return (
            <div key={col.status}>
              <div className="micro-label text-muted-foreground mb-2 flex items-center gap-1.5">
                <col.icon className="h-3.5 w-3.5" /> {col.label}
                <span className="font-data">({list.length})</span>
              </div>
              <div className="space-y-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} />
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
