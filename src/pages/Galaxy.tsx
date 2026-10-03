import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import * as d3 from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import "d3-transition";
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
import { useHouse } from "@/context/house";

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
  room: { id: number; name: string; floor: string | null } | null;
  verificationStatus: string;
};
type Area = { id: number; name: string; slug: string; color: string; icon: string };
type House = { id: number; name: string };

type Grouping = {
  id: string;
  label: string;
  /** Short tab text - just the level-1 dimension, since that's what the
   * bubble color/position actually reads as; the full "X → Y" stays
   * available as the tab's title tooltip. */
  shortLabel: string;
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

// group by room id, not name: two houses can each have a "Keuken"
const roomKey = (it: Item) => (it.room ? `${it.room.id}:${it.room.name.trim()}` : "none");
const roomKeyLabel = (key: string) => (key === "none" ? "No room" : key.slice(key.indexOf(":") + 1));

const GROUPINGS: Grouping[] = [
  {
    id: "house-floor",
    label: "House → Floor",
    shortLabel: "House",
    level1: (it) => String(it.houseId ?? "none"),
    level1Label: (key, _areas, houses) =>
      key === "none" ? "No house" : (houses.find((h) => String(h.id) === key)?.name ?? `House #${key}`),
    level1Color: (_key, index) => paletteColor(index),
    level1Nav: () => null,
    level1Icon: () => HomeIcon,
    level2: (it) => it.room?.floor?.trim() || "No floor",
    level2Label: (key) => key,
  },
  {
    id: "topic-floor",
    label: "Topic → Floor",
    shortLabel: "Topic · Floor",
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
    level2: (it) => it.room?.floor?.trim() || "No floor",
    level2Label: (key) => key,
  },
  {
    id: "floor-topic",
    label: "Floor → Topic",
    shortLabel: "Floor",
    level1: (it) => it.room?.floor?.trim() || "No floor",
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
    shortLabel: "Topic · Room",
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
    level2: roomKey,
    level2Label: roomKeyLabel,
  },
  {
    id: "room-topic",
    label: "Room → Topic",
    shortLabel: "Room",
    level1: roomKey,
    level1Label: (key) => roomKeyLabel(key),
    level1Color: (_key, index) => paletteColor(index),
    level1Nav: () => null,
    level1Icon: () => null,
    level2: (it) => String(it.areaId),
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
  hx?: number;
  hy?: number;
  /** level-1 only: radius to use for inter-cluster spacing, i.e. the disc's
   * own radius plus how far its leaf halo actually reaches - not a flat
   * guess, so clusters pack as tight as their real size allows. */
  spacingR?: number;
};

const W = 1300;
const H = 850;

/** Deterministic, evenly-spaced positions for `count` leaves inside an
 * angular wedge around a center - filling concentric arcs (more items on
 * an outer arc, since its circumference is longer) rather than one
 * overcrowded ring or a random scatter, so leaves read as an even halo
 * instead of a lopsided clump. Each ring's starting angle is staggered
 * (like brick coursing) so items don't line up into radial spokes, which
 * an aligned ring-by-ring layout produces otherwise. */
function wedgePlacements(count: number, startAngle: number, wedgeSpan: number, baseR: number, ringGap: number) {
  const maxPerRing = 9;
  const rings = Math.max(1, Math.ceil(count / maxPerRing));
  const base = Math.floor(count / rings);
  const extra = count % rings;
  const out: { angle: number; radius: number }[] = [];
  for (let r = 0; r < rings; r++) {
    const n = base + (r < extra ? 1 : 0);
    if (n === 0) continue;
    const radius = baseR + r * ringGap;
    const stagger = ((r % 2) * 0.5) / n;
    for (let i = 0; i < n; i++) {
      out.push({ angle: startAngle + (((i + 0.5) / n) + stagger) * wedgeSpan, radius });
    }
  }
  return out;
}

/** Custom d3-force: keeps every node strictly outside a circle (the
 * reference mindmap never lets a page dot sit on top of its own category
 * disc - they always surround it), by nudging velocity radially outward
 * whenever a node drifts inside `radius(n) + n.r + pad`. */
function forceAvoidCircle<N extends d3.SimulationNodeDatum & { r: number }>(
  center: (n: N) => { x: number; y: number },
  radius: (n: N) => number,
  pad = 4,
) {
  let nodes: N[] = [];
  function force(alpha: number) {
    for (const n of nodes) {
      const c = center(n);
      const minDist = radius(n) + n.r + pad;
      const dx = (n.x ?? 0) - c.x;
      const dy = (n.y ?? 0) - c.y;
      const dist = Math.hypot(dx, dy) || 0.001;
      if (dist < minDist) {
        const k = ((minDist - dist) / dist) * alpha;
        n.vx = (n.vx ?? 0) + dx * k;
        n.vy = (n.vy ?? 0) + dy * k;
      }
    }
  }
  force.initialize = (_nodes: N[]) => {
    nodes = _nodes;
  };
  return force;
}

export default function GalaxyPage() {
  const navigate = useNavigate();
  const areas = trpc.areas.list.useQuery();
  const houses = trpc.houses.list.useQuery();
  const [groupingId, setGroupingId] = useState(GROUPINGS[0].id);
  const grouping = GROUPINGS.find((g) => g.id === groupingId)!;
  // default to the house the rest of the app has "in context", not every
  // house mixed together - pick "all" explicitly to see the full inventory
  const { houseId: ctxHouseId } = useHouse();
  const [houseFilter, setHouseFilter] = useState<number | "all">(() => ctxHouseId ?? "all");
  // follow the header switcher: a house switch (or the provider's first
  // fallback) re-seeds the filter; picking a value here still overrides it
  const [seededFor, setSeededFor] = useState(ctxHouseId);
  if (seededFor !== ctxHouseId) {
    setSeededFor(ctxHouseId);
    setHouseFilter(ctxHouseId ?? "all");
  }
  const items = trpc.items.listAll.useQuery({ houseId: houseFilter === "all" ? null : houseFilter });

  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null);

  const ready = items.data && areas.data && houses.data;

  const built = useMemo(() => {
    if (!ready) return null;
    const areaList = areas.data! as Area[];
    const houseList = houses.data! as House[];
    const allItems = items.data! as Item[];

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

    // 1. lay out level-1 centers, spaced by each disc's OWN actual halo
    // reach (not a flat guess) so a cluster with 2 leaves sits almost as
    // close to its neighbor as its disc alone would allow, while a cluster
    // with 50 leaves still gets the room its halo actually needs
    const l1Nodes: SimNode[] = l1List.map((g1) => {
      const count = [...g1.l2.values()].reduce((s, g) => s + g.items.length, 0);
      const r = 18 + Math.sqrt(count) * 6;
      const maxRings = Math.max(1, ...[...g1.l2.values()].map((g2) => Math.ceil(g2.items.length / 9)));
      const spacingR = r + 14 + maxRings * 10 + 6;
      return { id: `1:${g1.key}`, r, spacingR, kind: "level1", color: g1.color, label: g1.label };
    });
    {
      const sim = d3
        .forceSimulation(l1Nodes)
        .force("charge", d3.forceManyBody().strength(-120))
        .force("collide", d3.forceCollide<SimNode>((n) => n.spacingR ?? n.r))
        .force("x", d3.forceX(W / 2).strength(0.12))
        .force("y", d3.forceY(H / 2).strength(0.12))
        .stop();
      for (let i = 0; i < 350; i++) sim.tick();
    }
    const l1Pos = new Map(l1Nodes.map((n) => [n.id.slice(2), n]));

    // 2. give every item a deterministic "home" position - items sharing a
    // level-2 sub-group get a contiguous angular wedge around their
    // level-1 circle (sized by their share of it), filled in concentric
    // arcs so they read as an even halo instead of one lopsided clump or
    // several overlapping side-blobs
    const itemNodes: SimNode[] = [];
    for (const g1 of l1List) {
      const parent = l1Pos.get(g1.key)!;
      const cx = parent.x ?? W / 2;
      const cy = parent.y ?? H / 2;
      const subsArr = [...g1.l2.values()];
      const total = subsArr.reduce((s, g) => s + g.items.length, 0) || 1;
      const gap = subsArr.length > 1 ? 0.14 : 0;
      let angleCursor = -Math.PI / 2; // start at 12 o'clock, read clockwise
      for (const g2 of subsArr) {
        const wedgeSpan = (Math.PI * 2 - gap * subsArr.length) * (g2.items.length / total);
        const placements = wedgePlacements(g2.items.length, angleCursor, wedgeSpan, parent.r + 14, 10);
        g2.items.forEach((it, i) => {
          const p = placements[i];
          // small deterministic jitter (seeded by item id) so the halo reads
          // as organic rather than a perfectly mechanical grid of arcs
          const seed = Math.sin(it.id * 12.9898) * 43758.5453;
          const jitter = seed - Math.floor(seed);
          const angle = p.angle + (jitter - 0.5) * (wedgeSpan / Math.max(g2.items.length, 1)) * 0.6;
          const radius = p.radius + (jitter - 0.5) * 6;
          const hx = cx + Math.cos(angle) * radius;
          const hy = cy + Math.sin(angle) * radius;
          itemNodes.push({
            id: `i:${it.id}`,
            r: 3.2,
            kind: "item",
            color: g1.color,
            label: it.name,
            item: it,
            parentId: g1.key,
            hx,
            hy,
            x: hx,
            y: hy,
          });
        });
        angleCursor += wedgeSpan + gap;
      }
    }
    return { l1Nodes, itemNodes, l1List, l1Pos };
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
  const simRef = useRef<d3.Simulation<SimNode, undefined> | null>(null);

  useEffect(() => {
    if (!built || !gRef.current) return;
    simRef.current?.stop();
    const g = select(gRef.current);
    g.selectAll("*").remove();

    // fit the whole scene in view on every grouping/filter change, so every
    // node and leaf starts visible instead of requiring a manual zoom/pan
    if (svgRef.current && zoomRef.current) {
      const margin = 48;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of [...built.l1Nodes, ...built.itemNodes]) {
        const extra = n.kind === "level1" ? 22 : 0; // room for the label under the disc
        minX = Math.min(minX, (n.x ?? 0) - n.r);
        maxX = Math.max(maxX, (n.x ?? 0) + n.r);
        minY = Math.min(minY, (n.y ?? 0) - n.r);
        maxY = Math.max(maxY, (n.y ?? 0) + n.r + extra);
      }
      if (Number.isFinite(minX)) {
        const bw = Math.max(maxX - minX, 50);
        const bh = Math.max(maxY - minY, 50);
        const scale = Math.min((W - margin * 2) / bw, (H - margin * 2) / bh, 6);
        const k = Math.min(Math.max(scale, 0.3), 6);
        const tx = W / 2 - k * (minX + maxX) / 2;
        const ty = H / 2 - k * (minY + maxY) / 2;
        select(svgRef.current)
          .transition()
          .duration(500)
          .call(zoomRef.current.transform, zoomIdentity.translate(tx, ty).scale(k));
      }
    }

    const linkLayer = g.append("g");
    const l1Layer = g.append("g");
    const itemLayer = g.append("g");
    const labelLayer = g.append("g");

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
        setTooltip({ x: ev.clientX, y: ev.clientY, title: it.name, sub: it.room ? it.room.name : "no room" });
      })
      .on("mousemove", (ev: MouseEvent) => {
        setTooltip((t) => (t ? { ...t, x: ev.clientX, y: ev.clientY } : t));
      })
      .on("mouseleave", (ev: MouseEvent, d) => {
        select(ev.currentTarget as SVGCircleElement).attr("r", d.r).attr("fill-opacity", 0.9);
        setTooltip(null);
      })
      .on("click", (_ev: MouseEvent, d) => navigate(`/items/${d.item!.id}`));

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

    const labelSel = labelLayer
      .selectAll<SVGTextElement, SimNode>("text")
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

    // live, never-stopping simulation (alphaTarget keeps it above 0) so the
    // scene has a constant gentle bounce rather than freezing once settled.
    // Each item has a precomputed, evenly-spaced home (hx/hy); the sim just
    // adds a soft wobble around it - charge/collide give it give, the x/y
    // anchor is strong enough that items don't wander into a neighboring
    // cluster's territory, and forceAvoidCircle is a safety net against
    // drifting back onto the level-1 disc itself.
    const l1Of = (item: SimNode) => built.l1Pos.get(item.parentId!)!;
    const sim = d3
      .forceSimulation(built.itemNodes)
      .velocityDecay(0.3)
      .force("charge", d3.forceManyBody().strength(-3))
      .force("collide", d3.forceCollide<SimNode>((n) => n.r + 1.2))
      .force("x", d3.forceX<SimNode>((n) => n.hx ?? W / 2).strength(0.25))
      .force("y", d3.forceY<SimNode>((n) => n.hy ?? H / 2).strength(0.25))
      .force(
        "avoidL1",
        forceAvoidCircle<SimNode>(
          (n) => ({ x: l1Of(n).x ?? W / 2, y: l1Of(n).y ?? H / 2 }),
          (n) => l1Of(n).r,
          3,
        ),
      )
      .alphaTarget(0.02)
      .on("tick", () => {
        itemSel.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
      });
    simRef.current = sim;

    itemSel.call(
      drag<SVGCircleElement, SimNode>()
        .on("start", (ev) => {
          if (!ev.active) sim.alphaTarget(0.3).restart();
          ev.subject.fx = ev.subject.x;
          ev.subject.fy = ev.subject.y;
        })
        .on("drag", (ev) => {
          ev.subject.fx = ev.x;
          ev.subject.fy = ev.y;
        })
        .on("end", (ev) => {
          if (!ev.active) sim.alphaTarget(0.02);
          ev.subject.fx = null;
          ev.subject.fy = null;
        }),
    );

    void labelSel;
    return () => {
      sim.stop();
    };
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
              title={g.label}
              onClick={() => setGroupingId(g.id)}
              className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                g.id === groupingId ? "bg-[#d2ff00] text-[#14160f]" : "bg-white/5 text-[#b4b8a5] hover:bg-white/10"
              }`}
            >
              {g.shortLabel}
            </button>
          ))}
        </div>
        <select
          className="rounded-full bg-white/5 border border-white/10 px-3 py-1.5 text-[12px] text-[#e0e0d0]"
          value={houseFilter}
          onChange={(e) => setHouseFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">All houses</option>
          {(houses.data ?? []).map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </select>
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
            <div className="micro-label text-[#b4b8a5] mb-1.5">{grouping.shortLabel}</div>
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
