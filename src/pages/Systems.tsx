import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import "d3-transition";
import { drag } from "d3-drag";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { formatBytes } from "@/components/storage/Blocks";
import { RatingStars } from "@/components/RatingStars";
import {
  buildSystemsGraph,
  classifyHub,
  type GraphComputer,
  type GraphItem,
  type GraphNode,
  type GraphVolume,
  type ItemScope,
} from "@/lib/systemsGraph";
import { parseRating, type Importance, type Rating } from "@/lib/systemsAttrs";

type SimNode = SimulationNodeDatum & GraphNode;
type SimLink = SimulationLinkDatum<SimNode> & { strength: number; cross?: boolean; tight?: boolean };

const IMP_STROKE: Record<Importance, { color: string; width: number }> = {
  kern: { color: "#fff", width: 3 },
  ondersteunend: { color: "#ff8c5a", width: 2 },
  proef: { color: "#fdcb6e", width: 2 },
  afvoeren: { color: "#636e72", width: 1.5 },
};

type OverviewVol = {
  id: number;
  mountPoint: string;
  label: string | null;
  usedBytes: number;
  capacityBytes: number;
  dataRole: string | null;
  dirCount: number;
};
type OverviewDevice = { id: number; name: string; kind: string; volumes: OverviewVol[] };
type OverviewComputer = OverviewDevice & {
  drives: OverviewDevice[];
  attached: OverviewDevice[];
};

function volsOf(d: OverviewDevice): GraphVolume[] {
  return d.volumes.map((v) => ({
    id: v.id,
    itemId: d.id,
    mountPoint: v.mountPoint,
    label: v.label,
    usedBytes: v.usedBytes,
    capacityBytes: v.capacityBytes,
    dataRole: v.dataRole,
    dirCount: v.dirCount,
  }));
}

function asComputer(c: OverviewComputer): GraphComputer {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    volumes: volsOf(c),
    drives: c.drives.map((d) => ({ id: d.id, name: d.name, volumes: volsOf(d) })),
    attached: c.attached.map((d) => ({ id: d.id, name: d.name, volumes: volsOf(d) })),
  };
}

function nodeStroke(d: GraphNode): { color: string; width: number } {
  if (d.type === "center") return { color: "#fff", width: 3 };
  if (d.type === "machine") {
    if (d.importance) return IMP_STROKE[d.importance];
    return { color: "#fff", width: 2 };
  }
  if (d.type === "network") return { color: "#7eeae6", width: 2 };
  if (d.type === "other") return { color: "#888", width: 1.5 };
  return { color: "none", width: 0 };
}

const SCOPE_OPTS: { id: ItemScope; label: string }[] = [
  { id: "machines", label: "Machines only" },
  { id: "network", label: "Incl. network" },
  { id: "all", label: "All Computers items" },
];

function runtimeChipLabel(k: string): string {
  if (k === "docker") return "containers";
  if (k === "web") return "web / PWA";
  return k;
}

const HUB_TYPES = new Set(["center", "machine", "network", "other"]);
const LEAF_TYPES = new Set(["service", "web", "disk", "volume"]);

function fitTransform(nodes: { x?: number; y?: number; radius: number; type: string }[], w: number, h: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const label = HUB_TYPES.has(n.type) && n.type !== "center" ? 16 : 0;
    minX = Math.min(minX, x - n.radius);
    maxX = Math.max(maxX, x + n.radius);
    minY = Math.min(minY, y - n.radius);
    maxY = Math.max(maxY, y + n.radius + label);
  }
  if (!Number.isFinite(minX)) return zoomIdentity;
  const margin = 24;
  const bw = Math.max(maxX - minX, 40);
  const bh = Math.max(maxY - minY, 40);
  const k = Math.min(Math.max(Math.min((w - margin * 2) / bw, (h - margin * 2) / bh), 0.12), 6);
  return zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(minX + maxX) / 2, -(minY + maxY) / 2);
}

export default function SystemsPage() {
  const { houses } = useHouse();
  // Default to all houses: live machines mostly sit in house 2, while the
  // header is often Thuis (house 1). null overrides x-house-id on the server.
  const [houseFilter, setHouseFilter] = useState<number | "all">("all");
  const houseIdArg: number | null = houseFilter === "all" ? null : houseFilter;

  const itemsQ = trpc.items.listAll.useQuery({ houseId: houseIdArg });
  const overviewQ = trpc.storage.overview.useQuery({ houseId: houseIdArg });
  const backsUpQ = trpc.items.listRelations.useQuery({ type: "backs-up" });
  const housesQ = trpc.houses.list.useQuery();
  const utils = trpc.useUtils();

  const [view, setView] = useState<"systems" | "services">("systems");
  const [scope, setScope] = useState<ItemScope>("machines");
  const [runtime, setRuntime] = useState<string | null>(null);
  const [minRating, setMinRating] = useState<Rating>(1);
  const [focusItemId, setFocusItemId] = useState<number | null>(null);
  const [detailSide, setDetailSide] = useState<"left" | "right">("right");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [legendKinds, setLegendKinds] = useState<string[]>([]);
  const legendKindsRef = useRef<string[]>([]);
  legendKindsRef.current = legendKinds;

  const diskVolumeId = selected?.volumeId ?? null;
  const dirsQ = trpc.storage.dirs.useQuery({ volumeId: diskVolumeId ?? 0 }, { enabled: diskVolumeId != null });

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const posRef = useRef(new Map<string, { x: number; y: number }>());
  const selectedIdRef = useRef<string | null>(null);
  const applyHighlightRef = useRef<(id: string | null) => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const nodesRef = useRef<SimNode[]>([]);
  const sizeRef = useRef({ w: 960, h: 640 });
  const [size, setSize] = useState({ w: 960, h: 640 });

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    applyHighlightRef.current(selected?.id ?? null);
  }, [selected, legendKinds]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 40 || r.height < 40) return;
      const next = { w: r.width, h: r.height };
      sizeRef.current = next;
      setSize(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const graphItems: GraphItem[] = useMemo(() => {
    const rows = (itemsQ.data ?? []) as Array<{
      id: number;
      name: string;
      parentId: number | null;
      areaSlug: string | null;
      areaName: string | null;
      houseId: number | null;
      status: string;
      attributes: GraphItem["attributes"];
      room: { name: string } | null;
    }>;
    const houseName = new Map((housesQ.data ?? houses).map((h) => [h.id, h.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      areaSlug: r.areaSlug,
      areaName: r.areaName,
      houseId: r.houseId,
      houseName: r.houseId != null ? houseName.get(r.houseId) ?? null : null,
      status: r.status,
      attributes: r.attributes,
      roomName: r.room?.name ?? null,
    }));
  }, [itemsQ.data, housesQ.data, houses]);

  const computers: GraphComputer[] = useMemo(() => {
    const o = overviewQ.data as { computers: OverviewComputer[]; externals: OverviewDevice[] } | undefined;
    if (!o) return [];
    const extras: GraphComputer[] = o.externals.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      volumes: volsOf(e),
      drives: [],
      attached: [],
    }));
    return [...o.computers.map(asComputer), ...extras];
  }, [overviewQ.data]);

  const relations = useMemo(
    () =>
      (backsUpQ.data ?? [])
        .filter((r) => r.status === "confirmed")
        .map((r) => ({ fromItemId: r.fromItemId, toItemId: r.toItemId })),
    [backsUpQ.data],
  );

  const houseList = housesQ.data ?? houses;
  const centerLabel =
    houseFilter === "all" ? "Systems" : (houseList.find((h) => h.id === houseFilter)?.name ?? "Systems");

  const volumeItemIds = useMemo(() => {
    const ids = new Set<number>();
    for (const c of computers) {
      if (c.volumes.length) ids.add(c.id);
      for (const d of c.drives) if (d.volumes.length) ids.add(d.id);
      for (const d of c.attached) if (d.volumes.length) ids.add(d.id);
    }
    return ids;
  }, [computers]);

  const machineOptions = useMemo(
    () =>
      graphItems
        .filter((it) => classifyHub(it, volumeItemIds) === "machine")
        .map((it) => ({ id: it.id, name: it.name, rating: parseRating(it.attributes) }))
        .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)),
    [graphItems, volumeItemIds],
  );

  const graph = useMemo(
    () =>
      buildSystemsGraph({
        items: graphItems,
        computers,
        view,
        runtime,
        centerLabel,
        relations,
        scope,
        volumeItemIds,
        minRating,
        focusItemId,
      }),
    [graphItems, computers, view, runtime, centerLabel, relations, scope, volumeItemIds, minRating, focusItemId],
  );

  useEffect(() => {
    if (view !== "services") return;
    if (runtime && !graph.runtimes.includes(runtime)) setRuntime(null);
  }, [view, runtime, graph.runtimes]);

  const patchAttrs = trpc.items.patchAttributes.useMutation({
    onSuccess: () => {
      void utils.items.listAll.invalidate();
      void utils.items.get.invalidate();
    },
  });

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svgSel = select(svgRef.current);
    const gSel = select(gRef.current);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.12, 6])
      .on("zoom", (ev) => gSel.attr("transform", (ev.transform as ZoomTransform).toString()));
    svgSel.call(z);
    zoomRef.current = z;
    return () => {
      svgSel.on(".zoom", null);
    };
  }, []);

  const runFit = () => {
    const svgEl = svgRef.current;
    const z = zoomRef.current;
    if (!svgEl || !z) return;
    const { w, h } = sizeRef.current;
    const t = fitTransform(nodesRef.current, w, h);
    select(svgEl).transition().duration(550).call(z.transform, t);
  };
  fitRef.current = runFit;

  useEffect(() => {
    if (!nodesRef.current.length) return;
    fitRef.current();
  }, [size.w, size.h]);

  useEffect(() => {
    if (!gRef.current || !svgRef.current) return;
    simRef.current?.stop();
    const g = select(gRef.current);
    g.selectAll("*").remove();
    const { w, h } = sizeRef.current;

    const nodes: SimNode[] = graph.nodes.map((n) => {
      const prev = posRef.current.get(n.id);
      return { ...n, x: prev?.x ?? w / 2, y: prev?.y ?? h / 2 };
    });
    const links: SimLink[] = graph.links.map((l) => ({ ...l }));

    const sim = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((d) => {
            const s = d.source as SimNode | string;
            const src = typeof s === "object" ? s : null;
            if (d.tight) return 40;
            if (src?.type === "center") return 180;
            if (d.cross) return 250;
            return 80;
          })
          .strength((d) => d.strength || 0.3),
      )
      .force(
        "charge",
        forceManyBody<SimNode>().strength((d) => {
          if (d.type === "center") return -600;
          if (d.type === "machine" || d.type === "network" || d.type === "other") return -300;
          return -40;
        }),
      )
      .force("center", forceCenter(w / 2, h / 2))
      .force(
        "collision",
        forceCollide<SimNode>().radius((d) => d.radius + 4),
      );

    const linkSel = g
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", (d) => (d.cross ? "#1a1a1a" : "#333"))
      .attr("stroke-width", (d) => {
        const s = d.source as SimNode | string;
        const sid = typeof s === "object" ? s.id : s;
        if (d.cross) return 0.5;
        return sid === "__center__" ? 2 : 1;
      })
      .attr("stroke-opacity", (d) => (d.cross ? 0.3 : 0.6));

    const nodeSel = g
      .append("g")
      .selectAll<SVGCircleElement, SimNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", (d) => d.radius)
      .attr("fill", (d) => d.color)
      .attr("fill-opacity", (d) => {
        if (d.dimmed) return 0.25;
        return LEAF_TYPES.has(d.type) ? 0.8 : 1;
      })
      .attr("stroke", (d) => nodeStroke(d).color)
      .attr("stroke-width", (d) => nodeStroke(d).width)
      .attr("cursor", (d) => (d.type === "center" ? "grab" : "pointer"))
      .call(
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
            if (!ev.active) sim.alphaTarget(0);
            ev.subject.fx = null;
            ev.subject.fy = null;
          }),
      );

    const hubLabel = g
      .append("g")
      .selectAll<SVGTextElement, SimNode>("text")
      .data(nodes.filter((d) => HUB_TYPES.has(d.type)))
      .join("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (d.type === "center" ? 5 : d.radius + 14))
      .attr("fill", (d) => (d.type === "center" ? "#fff" : d.color))
      .attr("font-size", (d) => (d.type === "center" ? "14px" : "11px"))
      .attr("font-weight", (d) => (d.type === "center" ? 700 : 600))
      .attr("opacity", (d) => (d.dimmed ? 0.4 : 1))
      .style("pointer-events", "none")
      .text((d) => d.label);

    const leafLabel = g
      .append("g")
      .selectAll<SVGTextElement, SimNode>("text")
      .data(nodes.filter((d) => LEAF_TYPES.has(d.type)))
      .join("text")
      .attr("text-anchor", "start")
      .attr("dx", 10)
      .attr("dy", 4)
      .attr("fill", "#888")
      .attr("font-size", "9px")
      .attr("opacity", 0)
      .style("pointer-events", "none")
      .text((d) => d.label);

    const applyHighlight = (id: string | null) => {
      const kinds = new Set(legendKindsRef.current);
      const connected = new Set<string>();
      if (kinds.size) {
        for (const n of nodes) if (kinds.has(n.type)) connected.add(n.id);
        for (const l of links) {
          const sid = typeof l.source === "object" ? l.source.id : String(l.source);
          const tid = typeof l.target === "object" ? l.target.id : String(l.target);
          if (connected.has(sid)) connected.add(tid);
          if (connected.has(tid)) connected.add(sid);
        }
      } else if (id) {
        connected.add(id);
        for (const l of links) {
          const sid = typeof l.source === "object" ? l.source.id : String(l.source);
          const tid = typeof l.target === "object" ? l.target.id : String(l.target);
          if (sid === id) connected.add(tid);
          if (tid === id) connected.add(sid);
        }
      }
      if (connected.size === 0) {
        nodeSel.attr("opacity", (d) => (d.dimmed ? 0.45 : 1));
        linkSel.attr("stroke-opacity", (d) => (d.cross ? 0.3 : 0.6));
        leafLabel.attr("opacity", 0);
        hubLabel.attr("opacity", (d) => (d.dimmed ? 0.4 : 1));
        return;
      }
      nodeSel.attr("opacity", (d) => {
        if (connected.has(d.id)) return d.dimmed ? 0.5 : 1;
        return 0.12;
      });
      linkSel.attr("stroke-opacity", (d) => {
        const sid = typeof d.source === "object" ? d.source.id : String(d.source);
        const tid = typeof d.target === "object" ? d.target.id : String(d.target);
        return connected.has(sid) && connected.has(tid) ? 0.8 : 0.02;
      });
      leafLabel.attr("opacity", (d) => (connected.has(d.id) ? 1 : 0));
      hubLabel.attr("opacity", (d) => (connected.has(d.id) ? 1 : 0.15));
    };
    applyHighlightRef.current = applyHighlight;
    applyHighlight(selectedIdRef.current);

    nodeSel
      .on("mouseover", (ev: MouseEvent, d) => {
        setTooltip({ x: ev.clientX, y: ev.clientY, node: d });
        if (!selectedIdRef.current && legendKindsRef.current.length === 0) applyHighlight(d.id);
      })
      .on("mousemove", (ev: MouseEvent) => {
        setTooltip((t) => (t ? { ...t, x: ev.clientX, y: ev.clientY } : t));
      })
      .on("mouseout", () => {
        setTooltip(null);
        applyHighlight(selectedIdRef.current);
      })
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        if (selectedIdRef.current === d.id) {
          setSelected(null);
          applyHighlight(null);
        } else {
          const copy: GraphNode = {
            id: d.id,
            type: d.type,
            label: d.label,
            radius: d.radius,
            color: d.color,
            dimmed: d.dimmed,
            itemId: d.itemId,
            volumeId: d.volumeId,
            importance: d.importance,
            rating: d.rating,
            kind: d.kind,
            tags: d.tags,
            lines: d.lines,
            href: d.href,
            usedPct: d.usedPct,
          };
          const { w: W } = sizeRef.current;
          const svgEl = svgRef.current;
          const screenX = svgEl ? ev.clientX - svgEl.getBoundingClientRect().left : ev.clientX;
          setDetailSide(screenX > W / 2 ? "left" : "right");
          setSelected(copy);
          applyHighlight(d.id);
        }
      })
      .on("dblclick", (ev: MouseEvent, d) => {
        ev.preventDefault();
        ev.stopPropagation();
        const svgEl = svgRef.current;
        const z = zoomRef.current;
        if (!svgEl || !z) return;
        const scale = d.type === "center" ? 1.2 : HUB_TYPES.has(d.type) ? 1.8 : 2.5;
        const { w: W, h: H } = sizeRef.current;
        const transform = zoomIdentity
          .translate(W / 2, H / 2)
          .scale(scale)
          .translate(-(d.x ?? 0), -(d.y ?? 0));
        select(svgEl).transition().duration(750).call(z.transform, transform);
      });

    select(svgRef.current).on("click.deselect", () => {
      if (selectedIdRef.current || legendKindsRef.current.length) {
        setSelected(null);
        setLegendKinds([]);
        applyHighlight(null);
      }
    });

    nodesRef.current = nodes;
    let fitted = false;
    const applyFit = (animate: boolean) => {
      const svgEl = svgRef.current;
      const z = zoomRef.current;
      if (!svgEl || !z) return;
      const { w: W, h: H } = sizeRef.current;
      const t = fitTransform(nodes, W, H);
      if (animate) select(svgEl).transition().duration(400).call(z.transform, t);
      else select(svgEl).call(z.transform, t);
    };
    applyFit(false);
    sim.on("end", () => {
      fitted = true;
      applyFit(true);
    });
    sim.on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);
      nodeSel.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
      hubLabel.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0);
      leafLabel.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0);
      for (const n of nodes) {
        if (n.x != null && n.y != null) posRef.current.set(n.id, { x: n.x, y: n.y });
      }
      if (!fitted) applyFit(false);
    });

    simRef.current = sim;
    return () => {
      sim.stop();
      applyHighlightRef.current = () => {};
      if (svgRef.current) select(svgRef.current).on("click.deselect", null);
    };
  }, [graph, size.w, size.h]);

  const ready = itemsQ.data && overviewQ.data;
  const leafCount = graph.nodes.filter((n) => n.type !== "center").length;
  const hubCount = graph.nodes.filter((n) => n.type === "machine" || n.type === "network" || n.type === "other").length;

  const toggleLegend = (type: string, ev: ReactMouseEvent) => {
    const multi = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    setSelected(null);
    setLegendKinds((prev) => {
      if (multi) return prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type];
      if (prev.length === 1 && prev[0] === type) return [];
      return [type];
    });
  };

  const refresh = () => {
    void utils.items.listAll.invalidate();
    void utils.storage.overview.invalidate();
    void utils.items.listRelations.invalidate();
    posRef.current.clear();
  };

  return (
    <div className="h-[calc(100vh-0px)] md:h-full flex flex-col bg-[#0a0a0a] text-[#e0e0e0] overflow-hidden font-[Inter,sans-serif]">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[#2a2a2a] bg-[rgba(10,10,10,.95)] shrink-0 flex-wrap">
        <div
          className="text-[1.2em] font-bold whitespace-nowrap"
          style={{ background: "linear-gradient(135deg,#ff6b35,#ff8c5a)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}
        >
          Systems
        </div>
        <div className="flex gap-2 flex-wrap">
          {(["systems", "services"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                posRef.current.clear();
                setSelected(null);
                setView(v);
              }}
              className={`px-3.5 py-1.5 rounded-full border text-[0.8em] font-medium transition-colors ${
                view === v
                  ? "bg-[#ff6b35] text-white border-[#ff6b35]"
                  : "bg-[#1a1a1a] text-[#888] border-[#333] hover:border-[#ff6b35] hover:text-[#ff6b35]"
              }`}
            >
              {v === "systems" ? "Systems" : "Services"}
            </button>
          ))}
          {view === "services" && (
            <>
              <button
                type="button"
                onClick={() => {
                  posRef.current.clear();
                  setSelected(null);
                  setRuntime(null);
                }}
                className={`px-3 py-1.5 rounded-full border text-[0.8em] font-medium transition-colors ${
                  runtime == null
                    ? "bg-[#ff6b35] text-white border-[#ff6b35]"
                    : "bg-[#1a1a1a] text-[#888] border-[#333] hover:border-[#ff6b35] hover:text-[#ff6b35]"
                }`}
              >
                all
              </button>
              {graph.runtimes.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    posRef.current.clear();
                    setSelected(null);
                    setRuntime(k);
                  }}
                  className={`px-3 py-1.5 rounded-full border text-[0.8em] font-medium transition-colors ${
                    runtime === k
                      ? "bg-[#ff6b35] text-white border-[#ff6b35]"
                      : "bg-[#1a1a1a] text-[#888] border-[#333] hover:border-[#ff6b35] hover:text-[#ff6b35]"
                  }`}
                >
                  {runtimeChipLabel(k)}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="flex rounded-full border border-[#333] overflow-hidden text-[11px] font-medium">
          {SCOPE_OPTS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                posRef.current.clear();
                setSelected(null);
                setScope(opt.id);
              }}
              className={`px-2.5 py-1.5 whitespace-nowrap transition-colors ${
                scope === opt.id ? "bg-[#2a2a2a] text-[#e0e0e0]" : "bg-transparent text-[#888] hover:text-[#ff6b35]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <select
          className="rounded-full bg-[#1a1a1a] border border-[#333] px-3 py-1.5 text-[12px] text-[#e0e0e0]"
          value={houseFilter}
          onChange={(e) => {
            posRef.current.clear();
            setHouseFilter(e.target.value === "all" ? "all" : Number(e.target.value));
          }}
        >
          <option value="all">All houses</option>
          {houseList.map((h) => (
            <option key={h.id} value={h.id} title={`house id ${h.id}`}>
              {h.name}
              {"itemCount" in h && typeof h.itemCount === "number" ? ` (${h.itemCount})` : ""}
            </option>
          ))}
        </select>
        <select
          className="rounded-full bg-[#1a1a1a] border border-[#333] px-3 py-1.5 text-[12px] text-[#e0e0e0] max-w-[220px]"
          value={focusItemId ?? ""}
          title="Focus one machine and its backs-up neighbours"
          onChange={(e) => {
            posRef.current.clear();
            setSelected(null);
            setFocusItemId(e.target.value === "" ? null : Number(e.target.value));
          }}
        >
          <option value="">All systems</option>
          {machineOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {"★".repeat(m.rating)} {m.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-[12px] text-[#888] whitespace-nowrap" title="Hide machines below this rating">
          <span className="text-[#e0e0e0] font-medium">★{minRating}+</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={minRating}
            aria-label="Minimum rating"
            className="w-20 accent-[#ff6b35]"
            onChange={(e) => {
              posRef.current.clear();
              setSelected(null);
              setMinRating(Number(e.target.value) as Rating);
            }}
          />
        </label>
        <div className="ml-auto flex items-center gap-4 text-[0.8em] text-[#666]">
          <span>
            <span className="text-[#ff6b35] font-semibold">{leafCount}</span> nodes
          </span>
          <span>
            <span className="text-[#ff6b35] font-semibold">{graph.links.length}</span> connections
          </span>
          <button
            type="button"
            title="Fit to view"
            onClick={() => fitRef.current()}
            className="rounded-md border border-[#333] px-2.5 py-1 text-[#888] hover:border-[#ff6b35] hover:text-[#ff6b35]"
          >
            Fit
          </button>
          <button
            type="button"
            title="Refresh data"
            onClick={refresh}
            className="rounded-md border border-[#333] px-2.5 py-1 text-[#888] hover:border-[#ff6b35] hover:text-[#ff6b35]"
          >
            ↻
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <svg ref={svgRef} width={size.w} height={size.h} className="block w-full h-full">
          <g ref={gRef} />
        </svg>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-[#888] text-sm">Loading systems…</div>
        )}

        {ready && hubCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[#888] text-sm px-8 text-center">
            {focusItemId != null || minRating > 1
              ? "No systems match this rating or selector. Lower ★ or pick All systems."
              : houseFilter !== "all"
                ? "No machines in this house. Try All houses — most computers live in another house."
                : scope === "all"
                  ? "No Computers items in this house."
                  : scope === "network"
                    ? "No machines or network gear in this house."
                    : "No machines in this house. Peripherals stay out; network gear is under Incl. network."}
          </div>
        )}

        {tooltip && (
          <div
            className="fixed z-50 pointer-events-none rounded-[10px] border border-[#333] bg-[rgba(26,26,26,.97)] px-[18px] py-3.5 text-[0.85em] max-w-[320px] backdrop-blur-sm"
            style={{ left: tooltip.x + 15, top: tooltip.y - 10 }}
          >
            <div className="font-bold text-white mb-1.5">{tooltip.node.label}</div>
            {tooltip.node.lines.slice(0, 4).map((row) => (
              <div key={row.k} className="text-[#aaa] text-[0.85em] leading-relaxed">
                {row.k}: {row.v}
              </div>
            ))}
            {tooltip.node.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tooltip.node.tags.slice(0, 8).map((t) => (
                  <span key={t} className="bg-[#2a2a2a] text-[#888] px-2 py-0.5 rounded-[10px] text-[0.75em]">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="text-[#ff6b35] text-[0.75em] mt-2 italic">Click for details · Dblclick to zoom</div>
          </div>
        )}

        {graph.legend.length > 0 && (
          <div className="absolute bottom-5 left-5 rounded-[10px] border border-[#2a2a2a] bg-[rgba(26,26,26,.95)] p-3.5 text-[0.75em] z-10">
            <div className="font-semibold text-[#888] mb-2 uppercase tracking-wide">
              {view === "services" ? `Runtime · ${runtime ?? "all"}` : "Systems"}
            </div>
            {graph.legend.map((row) => {
              const on = legendKinds.includes(row.type);
              return (
                <button
                  key={row.type}
                  type="button"
                  onClick={(e) => toggleLegend(row.type, e)}
                  className={`flex items-center gap-2 my-0.5 w-full text-left rounded px-1 py-0.5 ${
                    on ? "text-[#e0e0e0] bg-white/10" : "text-[#888] hover:text-[#e0e0e0]"
                  }`}
                  title="Click to isolate · Shift/⌘ multi-select"
                >
                  <span className="h-3 w-3 rounded-full shrink-0" style={{ background: row.color, opacity: legendKinds.length && !on ? 0.3 : 1 }} />
                  {row.label} ({row.count})
                </button>
              );
            })}
          </div>
        )}

        <div className="absolute bottom-5 right-5 rounded-[10px] border border-[#2a2a2a] bg-[rgba(26,26,26,.95)] px-4 py-3 text-[0.75em] text-[#666] z-10 hidden sm:block">
          <kbd className="bg-[#2a2a2a] px-1.5 py-0.5 rounded text-[#aaa]">Click</kbd> details ·{" "}
          <kbd className="bg-[#2a2a2a] px-1.5 py-0.5 rounded text-[#aaa]">Dblclick</kbd> zoom ·{" "}
          <kbd className="bg-[#2a2a2a] px-1.5 py-0.5 rounded text-[#aaa]">Hover</kbd> ·{" "}
          <kbd className="bg-[#2a2a2a] px-1.5 py-0.5 rounded text-[#aaa]">Scroll</kbd> zoom ·{" "}
          <kbd className="bg-[#2a2a2a] px-1.5 py-0.5 rounded text-[#aaa]">Drag</kbd> move
        </div>

        {selected && selected.type !== "center" && (
          <aside
            className={`absolute top-3 w-[min(280px,calc(100%-1.5rem))] rounded-[10px] border border-[#2a2a2a] bg-[rgba(26,26,26,.95)] p-4 z-20 backdrop-blur-sm max-h-[min(70vh,520px)] overflow-y-auto ${
              detailSide === "left" ? "left-3" : "right-3"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[#888] font-semibold">{selected.type}</div>
                <div className="font-bold text-white mt-0.5">{selected.label}</div>
              </div>
              <button
                type="button"
                className="text-[#888] hover:text-white text-lg leading-none"
                onClick={() => setSelected(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {selected.itemId != null && (selected.type === "machine" || selected.type === "network" || selected.type === "other") && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-[#888] font-semibold">Rating</span>
                <RatingStars
                  dark
                  value={selected.rating ?? 3}
                  disabled={patchAttrs.isPending}
                  onChange={(n: Rating) => {
                    const id = selected.itemId!;
                    patchAttrs.mutate({ id, set: { rating: n } });
                    setSelected((s) => {
                      if (!s) return s;
                      const lines = s.lines.some((l) => l.k === "rating")
                        ? s.lines.map((l) => (l.k === "rating" ? { k: "rating", v: `${n}/5` } : l))
                        : [...s.lines, { k: "rating", v: `${n}/5` }];
                      return { ...s, rating: n, lines };
                    });
                  }}
                />
              </div>
            )}
            <dl className="mt-3 space-y-1.5 text-[13px]">
              {selected.lines.filter((row) => row.k !== "rating").map((row) => (
                <div key={row.k} className="flex gap-2">
                  <dt className="text-[#666] w-20 shrink-0">{row.k}</dt>
                  <dd className="text-[#e0e0e0] break-all">
                    {row.k === "url" && /^https?:\/\//i.test(row.v) ? (
                      <a href={row.v} target="_blank" rel="noreferrer" className="text-[#4A90E2] underline">
                        {row.v}
                      </a>
                    ) : (
                      row.v
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {selected.tags.map((t) => (
                  <span key={t} className="bg-[#2a2a2a] text-[#888] px-2 py-0.5 rounded-[10px] text-[11px]">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {(selected.type === "disk" || selected.type === "volume") && diskVolumeId != null && (
              <div className="mt-3 border-t border-[#2a2a2a] pt-3">
                <div className="text-[11px] uppercase tracking-wide text-[#888] font-semibold mb-1.5">Folders</div>
                {dirsQ.isLoading && <div className="text-[#666] text-[12px]">Loading…</div>}
                {dirsQ.data && dirsQ.data.dirs.length === 0 && (
                  <div className="text-[#666] text-[12px]">No directory sizes reported yet.</div>
                )}
                {dirsQ.data?.dirs.slice(0, 12).map((d) => (
                  <div key={d.path} className="flex justify-between gap-2 text-[12px] py-0.5">
                    <span className="truncate text-[#aaa]" title={d.path}>
                      {d.path}
                    </span>
                    <span className="font-data text-[#888] shrink-0">{formatBytes(d.bytes)}</span>
                  </div>
                ))}
              </div>
            )}
            {selected.href &&
              (selected.href.startsWith("http") ? (
                <a
                  href={selected.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block text-[#ff6b35] text-[13px] italic hover:underline"
                >
                  Open URL →
                </a>
              ) : (
                <Link to={selected.href} className="mt-4 inline-block text-[#ff6b35] text-[13px] italic hover:underline">
                  {selected.volumeId != null ? "Open on Storage →" : "Open Thing →"}
                </Link>
              ))}
          </aside>
        )}
      </div>
    </div>
  );
}
