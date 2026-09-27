import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { CaptureBar } from "@/components/CaptureBar";
import { timeAgo } from "@/lib/format";
import { ArrowRight, Inbox, Lightbulb, ListChecks, Package } from "lucide-react";

export default function Dashboard() {
  const areas = trpc.areas.list.useQuery();
  const inboxList = trpc.inbox.list.useQuery();
  const tasks = trpc.tasks.list.useQuery();
  const ideas = trpc.ideas.list.useQuery();
  const events = trpc.events.list.useQuery({ limit: 12 });

  const pending = (inboxList.data ?? []).filter((c) => c.status === "pending").length;
  const openTasks = (tasks.data ?? []).filter((t) => t.status !== "done").length;
  const newIdeas = (ideas.data ?? []).filter((i) => i.status === "new").length;
  const totalItems = (areas.data ?? []).reduce((s, a) => s + a.itemCount, 0);

  const stats = [
    { label: "Items", value: totalItems, icon: Package, to: "/areas/computers" },
    { label: "Inbox pending", value: pending, icon: Inbox, to: "/inbox" },
    { label: "New ideas", value: newIdeas, icon: Lightbulb, to: "/ideas" },
    { label: "Open tasks", value: openTasks, icon: ListChecks, to: "/tasks" },
  ];

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Capture first, structure later — everything flows through the inbox.
      </p>

      <div className="mt-5">
        <CaptureBar />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        {stats.map((s) => (
          <Link
            key={s.label}
            to={s.to}
            className="rounded-lg border border-border bg-white px-4 py-3 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2 text-muted-foreground">
              <s.icon className="h-4 w-4" />
              <span className="micro-label">{s.label}</span>
            </div>
            <div className="font-data text-3xl mt-1.5">{s.value}</div>
          </Link>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-8">
        <section>
          <h2 className="micro-label text-muted-foreground mb-2">Areas</h2>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            {(areas.data ?? []).map((a) => (
              <Link
                key={a.id}
                to={`/areas/${a.slug}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40 transition-colors"
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: a.color }} />
                <span className="text-[13px] font-medium flex-1">{a.name}</span>
                <span className="font-data text-[12px] text-muted-foreground">{a.itemCount}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="micro-label text-muted-foreground mb-2">Recent activity</h2>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            {(events.data ?? []).length === 0 && (
              <div className="px-4 py-6 text-[13px] text-muted-foreground">Nothing yet — capture something above.</div>
            )}
            {(events.data ?? []).map((e) => (
              <div key={e.id} className="px-4 py-2 flex items-baseline gap-2">
                <span
                  className={`micro-label shrink-0 ${
                    e.actor === "ai" ? "text-violet-600" : e.actor === "system" ? "text-sky-600" : "text-muted-foreground"
                  }`}
                >
                  {e.actor}
                </span>
                <span className="text-[13px] flex-1 min-w-0 truncate">{e.summary}</span>
                <span className="font-data text-[11px] text-muted-foreground shrink-0">
                  {timeAgo(e.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
