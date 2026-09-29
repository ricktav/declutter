import { Link, useNavigate } from "react-router";
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { CaptureBar } from "@/components/CaptureBar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { timeAgo } from "@/lib/format";
import { ArrowRight, Inbox, Lightbulb, ListChecks, Package, Plus } from "lucide-react";
import {
  Laptop,
  Wrench,
  Home,
  ChefHat,
  Leaf,
  Briefcase,
  Calendar,
  Box,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const AREA_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "laptop", label: "Computers", icon: Laptop },
  { key: "wrench", label: "Tools", icon: Wrench },
  { key: "home", label: "House", icon: Home },
  { key: "chef-hat", label: "Kitchen", icon: ChefHat },
  { key: "leaf", label: "Garden", icon: Leaf },
  { key: "briefcase", label: "Work", icon: Briefcase },
  { key: "calendar", label: "Schedule", icon: Calendar },
  { key: "box", label: "General", icon: Box },
];

const AREA_COLORS = ["#5b8c5a", "#282c20", "#6366f1", "#0891b2", "#d97706", "#dc2626", "#7c3aed"];

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function AddAreaDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState("box");
  const [color, setColor] = useState(AREA_COLORS[0]);
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const create = trpc.areas.create.useMutation({
    onSuccess: (area) => {
      utils.areas.list.invalidate();
      setOpen(false);
      setName(""); setSlug(""); setSlugTouched(false); setIcon("box"); setColor(AREA_COLORS[0]); setDescription("");
      if (area) navigate(`/areas/${area.slug}`);
    },
  });

  const effectiveSlug = slugTouched ? slug : slugify(name);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-[12px]">
          <Plus className="h-3.5 w-3.5 mr-1" /> New area
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New area</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block">
            <span className="micro-label text-muted-foreground">Name</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              placeholder="e.g. Server Closet"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Slug (URL)</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px] font-data"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </label>
          <div>
            <span className="micro-label text-muted-foreground">Icon</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {AREA_ICONS.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  title={i.label}
                  onClick={() => setIcon(i.key)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md border",
                    icon === i.key
                      ? "border-primary bg-accent text-primary"
                      : "border-border bg-white text-muted-foreground hover:bg-accent"
                  )}
                >
                  <i.icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="micro-label text-muted-foreground">Color</span>
            <div className="mt-1 flex gap-1.5">
              {AREA_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-6 w-6 rounded-sm border-2",
                    color === c ? "border-primary" : "border-transparent"
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <label className="block">
            <span className="micro-label text-muted-foreground">Description (optional)</span>
            <input
              className="mt-0.5 w-full rounded-md border border-input bg-white px-2 py-1.5 text-[13px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="flex justify-end pt-1">
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={!name.trim() || !effectiveSlug.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  name: name.trim(),
                  slug: effectiveSlug.trim(),
                  icon,
                  color,
                  description: description.trim() || undefined,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create area"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
          <div className="flex items-center mb-2">
            <h2 className="micro-label text-muted-foreground">Areas</h2>
            <div className="ml-auto"><AddAreaDialog /></div>
          </div>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            {(areas.data ?? []).length === 0 && (
              <div className="px-4 py-5 text-[13px] text-muted-foreground space-y-1">
                <p>No areas yet — create one with the button above.</p>
                <p className="text-[12px]">
                  Want a head start? Run <code className="font-data rounded bg-accent px-1">npx tsx db/seed.ts</code> to load the starter set
                  (computers, garage, house, kitchen, garden, work, schedule).
                </p>
              </div>
            )}
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
