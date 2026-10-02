import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import * as d3 from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { drag } from "d3-drag";
import {
  Laptop,
  Wrench,
  Home as HomeIcon,
  ChefHat,
  Leaf,
  Briefcase,
  Calendar,
  Box,
  type LucideIcon,
} from "lucide-react";
import { trpc } from "@/providers/trpc";

const AREA_ICONS: Record<string, LucideIcon> = {
  laptop: Laptop,
  wrench: Wrench,
  home: HomeIcon,
  "chef-hat": ChefHat,
  leaf: Leaf,
  briefcase: Briefcase,
  calendar: Calendar,
  box: Box,
};

// a stable categorical palette for groupings that don't already carry their
// own color (house, floor, room) - areas use their own `color` field instead
const PALETTE = [
  "#e0724a", "#4aa3e0", "#e0c84a", "#4ae0a3", "#a34ae0",
  "#e04a7a", "#7ae04a", "#4a7ae0", "#e0944a", "#4ae0e0",
];

type Item = {
  id: number;
  name: string;
  areaId: number;
  houseId: number | null;
  floor: string | null;
  room: string | null;
  verificationStatus: string;
};
type Area = { id: number; name: string; slug: string; color: string; icon: string };
type House = { id: number; name: string };

type Grouping = {
  id: string;
  label: string;
  level1: (it: Item) => string;
  level1Label: (key: string, areas: Area[], houses: House[]) => string;
  level1Color: (key: string, index: number, areas: Area[]) => string;
  level1Nav: (key: string, areas: Area[]) => string | null;
  level1Icon: (key: string, areas: Area[]) => LucideIcon | null;
  level2: (it: Item) => string;
  level2Label: (key: string) => string;
};

function paletteColor(index: number) {
  return PALETTE[index % PALETTE.length];
}

const GROUPINGS: Grouping[] = [
  {
    id: "house-floor",
    label: "House → Floor",
    level1: (it) => String(it.houseId ?? "none"),
    level1Label: (key, _areas, houses) =>
      key === "none" ? "No house" : (houses.find((h) => String(h.id) === key)?.name ?? `House #${key}`),
    level1Color: (_key, index) => paletteColor(index),
    level1Nav: () => null,
    level1Icon: () => HomeIcon,
    level2: (it) => it.floor?.trim() || "No floor",
    level2Label: (key) => key,
  },
  {
    id: "topic-floor",
    label: "Topic → Floor",
    level1: (it) => String(it.areaId),
    level1Label: (key, areas) => areas.find((a) => String(a.id) === key)?.name ?? `Topic #${key}`,
    level1Color: (key, index, areas) => areas.find((a) => String(a.id) === key)?.color ?? paletteColor(index),
    level1Nav: (key, areas) => {
      const a = areas.find((a) => String(a.id) === key);
      return a ? `/areas/${a.slug}` : null;
    },
    level1Icon: (key, areas) => {
      const a = areas.find((a) => String(a.id) === key);
      return a ? (AREA_ICONS[a.icon] ?? Box) : null;
    },
    level2: (it) => it.floor?.trim() || "No floor",
    level2Label: (key) => key,
  },
  {
    id: "floor-topic",
    label: "Floor → Topic",
    level1: (it) => it.floor?.trim() || "No floor",
    level1Label: (key) => key,
    level1Color: (_key, index) => paletteColor(index),
    level1Nav: () => null,
    level1Icon: () => null,
    level2: (it) => String(it.areaId),
    level2Label: (key) => key,
  },
  {
    id: "topic-room",
    label: "Topic → Room",
    level1: (it) => String(it.areaId),
    level1Label: (key, areas) => areas.find((a) => String(a.id) === key)?.name ?? `Topic #${key}`,
    level1Color: (key, index, areas) => areas.find((a) => String(a.id) === key)?.color ?? paletteColor(index),
    level1Nav: (key, areas) => {
      const a = areas.find((a) => String(a.id) === key);
      return a ? `/areas/${a.slug}` : null;
    },
    level1Icon: (key, areas) => {
      const a = areas.find((a) => String(a.id) === key);
      return a ? (AREA_ICONS[a.icon] ?? Box) : null;
    },
    level2: (it) => it.room?.trim() || "No room",
    level2Label: (key) => key,
  },
];

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  r: number;
  kind: "level1" | "level2" | "item";
  color: string;
  label: string;
  item?: Item;
  parentId?: string;
};

const W = 1100;
const H = 720;

/** Settle a small force simulation synchronously (no live ticking) - used
 * to lay out cluster/sub-cluster centers once per grouping change, rather
 * than animating the whole scene every time a tab is clicked. */
function settle(nodes: SimNode[], opts: { charge: number; collidePad: number; cx: number; cy: number; strength: number }) {
  const sim = d3
    .forceSimulation(nodes)
    .force("charge", d3.forceManyBody().strength(opts.charge))
    .force("collide", d3.forceCollide<SimNode>((n) => n.r + opts.collidePad))
    .force("x", d3.forceX(opts.cx).strength(opts.strength))
    .force("y", d3.forceY(opts.cy).strength(opts.strength))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  return nodes;
}

export default function GalaxyPage() {
  const navigate = useNavigate();
  const items = trpc.items.listAll.useQuery({});
  const areas = trpc.areas.list.useQuery();
  const houses = trpc.houses.list.useQuery();
  const [groupingId, setGroupingId] = useState(GROUPINGS[0].id);
  const grouping = GROUPINGS.find((g) => g.id === groupingId)!;

  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null);

  const ready = items.data && areas.data && houses.data;

  const built = useMemo(() => {
    if (!ready) return null;
    const allItems = items.data! as Item[];
    const areaList = areas.data! as Area[];
    const houseList = houses.data! as House[];

    type L2 = { key: string; label: string; items: Item[] };
    type L1 = {
      key: string;
      label: string;
      color: string;
      nav: string | null;
      icon: LucideIcon | null;
      l2: Map<string, L2>;
    };
    const l1Map = new Map<string, L1>();
    for (const it of allItems) {
      const k1 = grouping.level1(it);
      let g1 = l1Map.get(k1);
      if (!g1) {
        g1 = { key: k1, label: "", color: "", nav: null, icon: null, l2: new Map() };
        l1Map.set(k1, g1);
      }
      const k2 = grouping.level2(it);
      let g2 = g1.l2.get(k2);
      if (!g2) {
        g2 = { key: k2, label: grouping.level2Label(k2), items: [] };
        g1.l2.set(k2, g2);
      }
      g2.items.push(it);
    }
    const l1List = [...l1Map.values()].sort((a, b) => {
      const an = [...a.l2.values()].reduce((s, g) => s + g.items.length, 0);
      const bn = [...b.l2.values()].reduce((s, g) => s + g.items.length, 0);
      return bn - an;
    });
    l1List.forEach((g1, i) => {
      g1.label = grouping.level1Label(g1.key, areaList, houseList);
      g1.color = grouping.level1Color(g1.key, i, areaList);
      g1.nav = grouping.level1Nav(g1.key, areaList);
      g1.icon = grouping.level1Icon(g1.key, areaList);
    });

    // 1. lay out level-1 centers
    const l1Nodes: SimNode[] = l1List.map((g1) => {
      const count = [...g1.l2.values()].reduce((s, g) => s + g.items.length, 0);
      return { id: `1:${g1.key}`, r: 18 + Math.sqrt(count) * 6, kind: "level1", color: g1.color, label: g1.label };
    });
    settle(l1Nodes, { charge: -900, collidePad: 24, cx: W / 2, cy: H / 2, strength: 0.06 });
    const l1Pos = new Map(l1Nodes.map((n) => [n.id.slice(2), n]));

    // 2. within each level-1, lay out level-2 sub-centers around its center
    const l2Nodes: SimNode[] = [];
    for (const g1 of l1List) {
      const parent = l1Pos.get(g1.key)!;
      const subs: SimNode[] = [...g1.l2.values()].map((g2) => ({
        id: `2:${g1.key}:${g2.key}`,
        r: 6 + Math.sqrt(g2.items.length) * 3,
        kind: "level2",
        color: g1.color,
        label: g2.label,
        parentId: g1.key,
        x: (parent.x ?? W / 2) + (Math.random() - 0.5) * 10,
        y: (parent.y ?? H / 2) + (Math.random() - 0.5) * 10,
      }));
      settle(subs, { charge: -40, collidePad: 6, cx: parent.x ?? W / 2, cy: parent.y ?? H / 2, strength: 0.3 });
      l2Nodes.push(...subs);
    }
    const l2Pos = new Map(l2Nodes.map((n) => [n.id, n]));

    // 3. leaf items, pulled toward their level-2 sub-center
    const itemNodes: SimNode[] = [];
    for (const g1 of l1List) {
      for (const g2 of g1.l2.values()) {
        const center = l2Pos.get(`2:${g1.key}:${g2.key}`)!;
        for (const it of g2.items) {
          itemNodes.push({
            id: `i:${it.id}`,
            r: 3.2,
            kind: "item",
            color: g1.color,
            label: it.name,
            item: it,
            parentId: `2:${g1.key}:${g2.key}`,
            x: (center.x ?? W / 2) + (Math.random() - 0.5) * (center.r * 1.6 + 4),
            y: (center.y ?? H / 2) + (Math.random() - 0.5) * (center.r * 1.6 + 4),
          });
        }
      }
    }
    const centerOf = (id: string) => l2Pos.get(id)!;
    const sim = d3
      .forceSimulation(itemNodes)
      .force("charge", d3.forceManyBody().strength(-1.5))
      .force("collide", d3.forceCollide<SimNode>((n) => n.r + 1))
      .force(
        "x",
        d3.forceX<SimNode>((n) => centerOf(n.parentId!).x ?? W / 2).strength(0.18),
      )
      .force(
        "y",
        d3.forceY<SimNode>((n) => centerOf(n.parentId!).y ?? H / 2).strength(0.18),
      )
      .stop();
    for (let i = 0; i < 220; i++) sim.tick();

    return { l1Nodes, l2Nodes, itemNodes, l1List };
  }, [ready, items.data, areas.data, houses.data, groupingId]);

  // one-time zoom behavior setup
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svgSel = select(svgRef.current);
    const gSel = select(gRef.current);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 6])
      .on("zoom", (ev) => gSel.attr("transform", ev.transform.toString()));
    svgSel.call(z);
    zoomRef.current = z;
    svgSel.call(z.transform, zoomIdentity);
  }, []);

  // imperative render of the current layout into the svg <g>
  useEffect(() => {
    if (!built || !gRef.current) return;
    const g = select(gRef.current);
    g.selectAll("*").remove();

    const linkLayer = g.append("g");
    const l2Layer = g.append("g");
    const l1Layer = g.append("g");
    const itemLayer = g.append("g");
    const labelLayer = g.append("g");

    // faint sub-cluster rings for depth, matching the reference's layered look
    l2Layer
      .selectAll("circle")
      .data(built.l2Nodes)
      .join("circle")
      .attr("cx", (d) => d.x ?? 0)
      .attr("cy", (d) => d.y ?? 0)
      .attr("r", (d) => d.r)
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", 0.07)
      .attr("stroke", (d) => d.color)
      .attr("stroke-opacity", 0.25);

    const itemSel = itemLayer
      .selectAll<SVGCircleElement, SimNode>("circle")
      .data(built.itemNodes)
      .join("circle")
      .attr("cx", (d) => d.x ?? 0)
      .attr("cy", (d) => d.y ?? 0)
      .attr("r", (d) => d.r)
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", 0.9)
      .attr("stroke", "#0b0d08")
      .attr("stroke-width", 0.4)
      .style("cursor", "pointer")
      .on("mouseenter", (ev: MouseEvent, d) => {
        select(ev.currentTarget as SVGCircleElement).attr("r", d.r * 2.2).attr("fill-opacity", 1);
        const it = d.item!;
        const loc = [it.floor, it.room].filter(Boolean).join(" · ") || "no location";
        setTooltip({ x: ev.clientX, y: ev.clientY, title: it.name, sub: loc });
      })
      .on("mousemove", (ev: MouseEvent) => {
        setTooltip((t) => (t ? { ...t, x: ev.clientX, y: ev.clientY } : t));
      })
      .on("mouseleave", (ev: MouseEvent, d) => {
        select(ev.currentTarget as SVGCircleElement).attr("r", d.r).attr("fill-opacity", 0.9);
        setTooltip(null);
      })
      .on("click", (_ev: MouseEvent, d) => navigate(`/items/${d.item!.id}`));

    itemSel.call(
      drag<SVGCircleElement, SimNode>()
        .on("start", (ev) => {
          ev.subject.fx = ev.subject.x;
          ev.subject.fy = ev.subject.y;
        })
        .on("drag", (ev) => {
          ev.subject.fx = ev.x;
          ev.subject.fy = ev.y;
          select(ev.sourceEvent.target as SVGCircleElement).attr("cx", ev.x).attr("cy", ev.y);
        })
        .on("end", (ev) => {
          ev.subject.fx = null;
          ev.subject.fy = null;
        }),
    );

    const l1Sel = l1Layer
      .selectAll<SVGCircleElement, SimNode>("circle")
      .data(built.l1Nodes)
      .join("circle")
      .attr("cx", (d) => d.x ?? 0)
      .attr("cy", (d) => d.y ?? 0)
      .attr("r", (d) => d.r)
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", 0.9)
      .attr("stroke", "#f4f4ed")
      .attr("stroke-width", 2)
      .style("cursor", (d) => {
        const g1 = built.l1List.find((x) => x.key === d.id.slice(2));
        return g1?.nav ? "pointer" : "default";
      })
      .on("click", (_ev: MouseEvent, d) => {
        const g1 = built.l1List.find((x) => x.key === d.id.slice(2));
        if (g1?.nav) navigate(g1.nav);
      });
    void l1Sel;

    labelLayer
      .selectAll("text")
      .data(built.l1Nodes)
      .join("text")
      .attr("x", (d) => d.x ?? 0)
      .attr("y", (d) => (d.y ?? 0) + d.r + 14)
      .attr("text-anchor", "middle")
      .attr("fill", "#f4f4ed")
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .style("pointer-events", "none")
      .text((d) => d.label);

    void linkLayer;
  }, [built, navigate]);

  const totalItems = built?.itemNodes.length ?? 0;
  const totalGroups = built?.l1Nodes.length ?? 0;

  return (
    <div className="-m-6 h-[calc(100vh-0px)] flex flex-col bg-[#14160f] text-[#f4f4ed] overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 shrink-0">
        <div className="font-data text-[15px] font-semibold tracking-tight">🌌 Inventory Galaxy</div>
        <div className="flex items-center gap-1 ml-2">
          {GROUPINGS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroupingId(g.id)}
              className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                g.id === groupingId ? "bg-[#d2ff00] text-[#14160f]" : "bg-white/5 text-[#b4b8a5] hover:bg-white/10"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-4 font-data text-[12px] text-[#b4b8a5]">
          <span><span className="text-[#d2ff00] font-semibold">{totalItems}</span> items</span>
          <span><span className="text-[#d2ff00] font-semibold">{totalGroups}</span> groups</span>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
          <g ref={gRef} />
        </svg>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-[#b4b8a5] text-sm">
            Loading inventory…
          </div>
        )}

        {tooltip && (
          <div
            className="fixed z-50 pointer-events-none rounded-md bg-[#0b0d08] border border-white/15 px-2.5 py-1.5 text-[12px] shadow-lg"
            style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
          >
            <div className="font-medium">{tooltip.title}</div>
            <div className="text-[#b4b8a5] text-[11px]">{tooltip.sub}</div>
          </div>
        )}

        {built && (
          <div className="absolute bottom-4 left-4 rounded-lg bg-[#0b0d08]/90 border border-white/10 px-3 py-2.5 max-w-[220px]">
            <div className="micro-label text-[#b4b8a5] mb-1.5">{grouping.label.split(" → ")[0]}</div>
            <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
              {built.l1List.map((g1) => (
                <div key={g1.key} className="flex items-center gap-1.5 text-[11px]">
                  {g1.icon ? (
                    <g1.icon className="h-3 w-3 shrink-0" style={{ color: g1.color }} />
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: g1.color }} />
                  )}
                  <span className="flex-1 truncate">{g1.label}</span>
                  <span className="text-[#b4b8a5] font-data">
                    {[...g1.l2.values()].reduce((s, x) => s + x.items.length, 0)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="absolute bottom-4 right-4 font-data text-[10px] text-[#6a6e5e]">
          Click: open item · Hover: details · Drag: nudge · Scroll: zoom
        </div>
      </div>
    </div>
  );
}
