import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAsk } from "@/context/ask";
import {
  LayoutDashboard,
  Inbox,
  Lightbulb,
  ListChecks,
  BookOpen,
  History,
  Sparkles,
  Timer,
  Square,
  Laptop,
  Wrench,
  Home,
  ChefHat,
  Leaf,
  Briefcase,
  Calendar,
  Box,
  Camera,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

const AREA_ICONS: Record<string, LucideIcon> = {
  laptop: Laptop,
  wrench: Wrench,
  home: Home,
  "chef-hat": ChefHat,
  leaf: Leaf,
  briefcase: Briefcase,
  calendar: Calendar,
  box: Box,
};

function RunningTimerPill() {
  const running = trpc.tasks.runningTimer.useQuery(undefined, { refetchInterval: 5000 });
  const stop = trpc.tasks.stopTimer.useMutation({
    onSuccess: () => {
      utils.tasks.runningTimer.invalidate();
      utils.tasks.list.invalidate();
    },
  });
  const utils = trpc.useUtils();
  const [, force] = useState(0);
  useEffect(() => {
    if (!running.data) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running.data?.logId]);

  if (!running.data) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(running.data.startedAt).getTime()) / 1000));
  return (
    <div className="flex items-center gap-2 rounded-md bg-[#d2ff00]/10 border border-[#d2ff00]/30 px-2.5 py-1.5">
      <Timer className="h-3.5 w-3.5 text-[#b2c73a]" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] truncate text-[#e0e0d0]">{running.data.taskTitle}</div>
        <div className="font-data text-[13px] text-[#d2ff00]">{formatClock(elapsed)}</div>
      </div>
      <button
        onClick={() => stop.mutate({ taskId: running.data!.taskId })}
        className="text-[#b2c73a] hover:text-[#d2ff00]"
        title="Stop timer"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/snap", label: "Snap", icon: Camera },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/ideas", label: "Ideas", icon: Lightbulb },
  { to: "/tasks", label: "Tasks", icon: ListChecks },
  { to: "/wiki", label: "Wiki", icon: BookOpen },
  { to: "/activity", label: "Activity", icon: History },
];

export default function Layout() {
  const areas = trpc.areas.list.useQuery();
  const inbox = trpc.inbox.list.useQuery();
  const { openAsk } = useAsk();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingCount = (inbox.data ?? []).filter((c) => c.status === "pending").length;

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
      isActive
        ? "bg-[#3a3f2e] text-[#f4f4ed]"
        : "text-[#b4b8a5] hover:bg-[#32361f] hover:text-[#e0e0d0]",
    );

  const sidebar = (
    <>
      <div className="px-4 pt-5 pb-4 flex items-start">
        <div>
          <div className="font-data text-[15px] font-semibold tracking-tight text-[#f4f4ed]">
            ⌂ HomeBase
          </div>
          <div className="micro-label text-[#b4b8a5] mt-0.5">inventory os</div>
        </div>
        <button className="md:hidden ml-auto text-[#b4b8a5] p-1" onClick={() => setMenuOpen(false)}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="px-2 space-y-0.5">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={navLinkClass}
            onClick={() => setMenuOpen(false)}>
            <n.icon className="h-4 w-4" />
            <span className="flex-1">{n.label}</span>
            {n.to === "/inbox" && pendingCount > 0 && (
              <span className="font-data text-[11px] bg-[#d2ff00] text-[#282c20] rounded-full px-1.5 py-px">
                {pendingCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="micro-label text-[#b4b8a5] px-4 mt-6 mb-1.5">Areas</div>
      <nav className="px-2 space-y-0.5 flex-1 overflow-y-auto">
        {(areas.data ?? []).map((a) => {
          const Icon = AREA_ICONS[a.icon] ?? Box;
          return (
            <NavLink key={a.id} to={`/areas/${a.slug}`} className={navLinkClass}
              onClick={() => setMenuOpen(false)}>
              <Icon className="h-4 w-4" style={{ color: a.color }} />
              <span className="flex-1 truncate">{a.name}</span>
              <span className="font-data text-[11px] opacity-60">{a.itemCount}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="p-2 space-y-2">
        <RunningTimerPill />
        <button
          onClick={() => { setMenuOpen(false); openAsk("global", 0, "Whole inventory"); }}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-[#d2ff00] text-[#282c20] text-[13px] font-semibold px-3 py-2 hover:bg-[#e2ff4d] transition-colors"
        >
          <Sparkles className="h-4 w-4" /> Ask AI
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-[220px] shrink-0 flex-col bg-[#282c20] text-[#e0e0d0]">
        {sidebar}
      </aside>

      {/* mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[260px] flex flex-col bg-[#282c20] text-[#e0e0d0]">
            {sidebar}
          </aside>
        </div>
      )}

      {/* ---- main ---- */}
      <main className="flex-1 overflow-y-auto">
        {/* mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 flex items-center gap-2 bg-[#282c20] text-[#e0e0d0] px-3 py-2">
          <button onClick={() => setMenuOpen(true)} className="p-1">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-data text-[13px] font-semibold text-[#f4f4ed]">⌂ HomeBase</span>
          <RunningTimerPill />
        </div>
        <Outlet context={{ navigate }} />
      </main>
    </div>
  );
}
