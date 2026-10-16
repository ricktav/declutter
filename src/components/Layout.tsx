import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useWorkbenchMode } from "@/context/workbenchMode";
import { DEPTHS, useDepth, type Depth } from "@/context/depth";
import { trpc } from "@/providers/trpc";
import { useAsk } from "@/context/ask";
import { HouseSwitcher } from "@/components/HouseSwitcher";
import { SidebarRooms } from "@/components/SidebarRooms";
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
  Menu,
  X,
  Settings,
  Search,
  ScanSearch,
  ChevronDown,
  ChevronRight,
  Images,
  Network,
  Share2,
  Smartphone,
  Zap,
  HardDrive,
  Star,
} from "lucide-react";
import { formatClock } from "@/lib/format";
import { areaIcon } from "@/lib/areaStyle";
import { cn } from "@/lib/utils";
import { useTopicFavs } from "@/lib/topicFavs";
import { useLinks } from "@/hooks/use-links";

function useCollapsed(key: string, initial = false) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // private browsing / storage disabled - collapse state just won't persist
      }
      return next;
    });
  return [collapsed, toggle] as const;
}

function SidebarSectionTitle({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-1 px-4 mt-6 mb-1.5 text-hb-sage hover:text-hb-paper"
    >
      {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      <span className="micro-label">{label}</span>
    </button>
  );
}

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
    <div className="flex items-center gap-2 rounded-md bg-hb-lime/10 border border-hb-lime/30 px-2.5 py-1.5">
      <Timer className="h-3.5 w-3.5 text-hb-lime-dim" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] truncate text-hb-paper">{running.data.taskTitle}</div>
        <div className="font-data text-[13px] text-hb-lime">{formatClock(elapsed)}</div>
      </div>
      <button
        onClick={() => stop.mutate({ taskId: running.data!.taskId })}
        className="text-hb-lime-dim hover:text-hb-lime"
        title="Stop timer"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const PRIMARY_NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/focus", label: "Focus", icon: ScanSearch },
  { to: "/inbox", label: "Sort", icon: Inbox },
  { to: "/items", label: "All Things", icon: Search },
  { to: "/photos", label: "Photos", icon: Images },
  { to: "/settings", label: "Settings", icon: Settings },
];

const VIEWS_NAV = [
  { to: "/galaxy", label: "Galaxy", icon: Network },
  { to: "/systems", label: "Systems", icon: Share2 },
  { to: "/storage", label: "Storage", icon: HardDrive },
  { to: "/wiki", label: "Wiki", icon: BookOpen },
  { to: "/activity", label: "Activity", icon: History },
];

/** Views that only show up once the house has data for them. */
const DATA_VIEWS: Record<string, "systems" | "storage"> = { "/systems": "systems", "/storage": "storage" };

const SIMPLE_NAV = new Set(["/focus", "/inbox", "/items", "/photos", "/settings"]);
const HEAVY_PATHS = new Set(["/galaxy", "/systems", "/storage", "/ideas", "/tasks", "/wiki", "/activity"]);

const DEPTH_LABEL: Record<Depth, { label: string; title: string }> = {
  quick: { label: "Quick", title: "Snap, sort and decide: Focus, Inbox, Things, Photos" },
  standard: { label: "Standard", title: "Everyday pages, without the extra views" },
  detail: { label: "Detail", title: "Everything, including views and lenses" },
};

function WorkbenchModeToggle({ compact = false }: { compact?: boolean }) {
  const { depth, setDepth } = useDepth();
  const navigate = useNavigate();
  const pick = (next: Depth) => {
    setDepth(next);
    if (next === "quick") navigate("/focus");
  };
  return (
    <div
      className={cn(
        "grid grid-cols-3 rounded-md bg-hb-charcoal-hover p-0.5 text-[11px] font-semibold",
        compact && "min-w-[12rem]",
      )}
      role="group"
      aria-label="Workbench depth"
    >
      {DEPTHS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => pick(d)}
          title={DEPTH_LABEL[d].title}
          aria-pressed={depth === d}
          className={cn(
            "rounded px-1.5 py-1",
            depth === d ? "bg-hb-lime text-hb-charcoal" : "text-hb-sage hover:text-hb-paper-bright",
          )}
        >
          {DEPTH_LABEL[d].label}
        </button>
      ))}
    </div>
  );
}

export default function Layout() {
  const { mode } = useWorkbenchMode();
  const { meterkastUrl } = useLinks();
  const { shows } = useDepth();
  const location = useLocation();
  const areas = trpc.areas.list.useQuery();
  const { favIds, toggle: toggleFav, isFaved } = useTopicFavs();
  const inbox = trpc.inbox.list.useQuery();
  const { openAsk } = useAsk();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [areasCollapsed, toggleAreas] = useCollapsed("sidebar.areas.collapsed");
  const [locationsCollapsed, toggleLocations] = useCollapsed("sidebar.locations.collapsed");
  const [viewsCollapsed, toggleViews] = useCollapsed("sidebar.views.collapsed", true);
  const ideasList = trpc.ideas.list.useQuery();
  const tasksList = trpc.tasks.list.useQuery();
  const hasIdeas = (ideasList.data ?? []).length > 0;
  const hasTasks = (tasksList.data ?? []).length > 0;
  const pendingCount = (inbox.data ?? []).filter((c) => c.status === "pending").length;
  const primaryNav = mode === "simple" ? PRIMARY_NAV.filter((n) => SIMPLE_NAV.has(n.to)) : PRIMARY_NAV;
  const extraPrimary = mode === "simple" ? [] : [
    ...(hasIdeas ? [{ to: "/ideas", label: "Ideas", icon: Lightbulb }] : []),
    ...(hasTasks ? [{ to: "/tasks", label: "Tasks", icon: ListChecks }] : []),
  ];
  const views = trpc.settings.views.useQuery(undefined, { staleTime: 60_000 });
  const viewsNav = [
    ...VIEWS_NAV.filter((v) => !(v.to in DATA_VIEWS) || views.data?.[DATA_VIEWS[v.to]] === true),
    ...(!hasIdeas ? [{ to: "/ideas", label: "Ideas", icon: Lightbulb }] : []),
    ...(!hasTasks ? [{ to: "/tasks", label: "Tasks", icon: ListChecks }] : []),
  ];
  useEffect(() => {
    if (mode !== "simple") return;
    if (location.pathname === "/" || HEAVY_PATHS.has(location.pathname)) {
      navigate("/focus", { replace: true });
    }
  }, [mode, location.pathname, navigate]);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
      isActive
        ? "bg-hb-charcoal-2 text-hb-paper-bright"
        : "text-hb-sage hover:bg-hb-charcoal-hover hover:text-hb-paper",
    );

  const sidebar = (
    <>
      <div className="px-4 pt-5 pb-4 flex items-start">
        <div>
          <div className="font-data text-[15px] font-semibold tracking-tight text-hb-paper-bright">
            ⌂ HomeBase
          </div>
          <div className="micro-label text-hb-sage mt-0.5">inventory os</div>
        </div>
        <button className="md:hidden ml-auto text-hb-sage p-1" onClick={() => setMenuOpen(false)}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-2 pb-2 space-y-2">
        <HouseSwitcher dark allowAll />
        <WorkbenchModeToggle />
      </div>

      <nav className="px-2 space-y-0.5">
        {favIds.length > 0 && (
          <div className="space-y-0.5 pb-1 mb-1 border-b border-hb-charcoal-2">
            {favIds.map((id) => {
              const a = (areas.data ?? []).find((x) => x.id === id);
              if (!a) return null;
              const Icon = areaIcon(a.icon);
              return (
                <div key={`fav-${a.id}`} className="flex items-center">
                  <NavLink
                    to={`/areas/${a.slug}`}
                    className={(s) => cn(navLinkClass(s), "flex-1 min-w-0")}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon className="h-4 w-4" style={{ color: a.color }} />
                    <span className="flex-1 truncate">{a.name}</span>
                  </NavLink>
                  <button
                    type="button"
                    title="Remove shortcut"
                    className="shrink-0 rounded p-1 mr-1 text-hb-sage hover:bg-hb-charcoal-hover hover:text-hb-paper-bright"
                    onClick={() => toggleFav(a.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {[...primaryNav, ...extraPrimary].map((n) => (
          <NavLink key={n.to} to={n.to} end={"end" in n && n.end === true} className={navLinkClass}
            onClick={() => setMenuOpen(false)}>
            <n.icon className="h-4 w-4" />
            <span className="flex-1">{n.label}</span>
            {n.to === "/inbox" && pendingCount > 0 && (
              <span className="font-data text-[11px] bg-hb-lime text-hb-charcoal rounded-full px-1.5 py-px">
                {pendingCount}
              </span>
            )}
          </NavLink>
        ))}
        <SidebarSectionTitle label="Views" collapsed={viewsCollapsed} onToggle={toggleViews} />
        {!viewsCollapsed && (
          <div className="space-y-0.5">
            {shows("detail") && viewsNav.map((n) => (
              <NavLink key={n.to} to={n.to} className={navLinkClass} onClick={() => setMenuOpen(false)}>
                <n.icon className="h-4 w-4" />
                <span className="flex-1">{n.label}</span>
              </NavLink>
            ))}
            <a href="/flow/" className={navLinkClass({ isActive: false })}>
              <Smartphone className="h-4 w-4" />
              <span className="flex-1">Flow</span>
              <span className="text-[11px] opacity-60">↗</span>
            </a>
            {shows("detail") && meterkastUrl && (
              <a href={meterkastUrl} target="_blank" rel="noreferrer" className={navLinkClass({ isActive: false })}>
                <Zap className="h-4 w-4" />
                <span className="flex-1">Meterkast</span>
                <span className="text-[11px] opacity-60">↗</span>
              </a>
            )}
          </div>
        )}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <SidebarSectionTitle label="Kinds" collapsed={areasCollapsed} onToggle={toggleAreas} />
        {!areasCollapsed && (
          <nav className="px-2 space-y-0.5">
            {(areas.data ?? []).map((a) => {
              const Icon = areaIcon(a.icon);
              return (
                <div key={a.id} className="flex items-center">
                  <NavLink
                    to={`/areas/${a.slug}`}
                    className={(s) => cn(navLinkClass(s), "flex-1 min-w-0")}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon className="h-4 w-4" style={{ color: a.color }} />
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className="font-data text-[11px] opacity-60">{a.itemCount}</span>
                  </NavLink>
                  <button
                    type="button"
                    title={isFaved(a.id) ? "Remove shortcut" : "Pin under Home"}
                    className={cn(
                      "shrink-0 rounded p-1 mr-1",
                      isFaved(a.id) ? "text-hb-lime" : "text-hb-sage hover:bg-hb-charcoal-hover hover:text-hb-paper-bright",
                    )}
                    onClick={() => toggleFav(a.id)}
                  >
                    <Star className={cn("h-3 w-3", isFaved(a.id) && "fill-current")} />
                  </button>
                </div>
              );
            })}
          </nav>
        )}

        <SidebarSectionTitle label="Places" collapsed={locationsCollapsed} onToggle={toggleLocations} />
        {!locationsCollapsed && <SidebarRooms navLinkClass={navLinkClass} onNavigate={() => setMenuOpen(false)} />}
      </div>

      <div className="p-2 space-y-2">
        <RunningTimerPill />
        <button
          onClick={() => { setMenuOpen(false); openAsk("global", 0, "Whole inventory"); }}
          className="w-full flex items-center justify-center gap-2 rounded-md bg-hb-lime text-hb-charcoal text-[13px] font-semibold px-3 py-2 hover:bg-hb-lime-hover transition-colors"
        >
          <Sparkles className="h-4 w-4" /> Ask AI
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* desktop sidebar */}
      <aside className="hidden md:flex w-[240px] shrink-0 flex-col overflow-x-hidden bg-hb-charcoal text-hb-paper">
        {sidebar}
      </aside>

      {/* mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[min(260px,85vw)] flex flex-col overflow-x-hidden bg-hb-charcoal text-hb-paper">
            {sidebar}
          </aside>
        </div>
      )}

      {/* ---- main ---- */}
      <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        {/* mobile top bar */}
        <div className="md:hidden sticky top-0 z-30 flex items-center gap-2 bg-hb-charcoal text-hb-paper px-3 py-2">
          <button onClick={() => setMenuOpen(true)} className="p-1">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-data text-[13px] font-semibold text-hb-paper-bright">⌂ HomeBase</span>
          <div className="ml-auto">
            <WorkbenchModeToggle compact />
          </div>
          <RunningTimerPill />
        </div>
        <Outlet context={{ navigate }} />
      </main>
    </div>
  );
}
