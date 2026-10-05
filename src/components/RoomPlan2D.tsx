import { useRef, useState } from "react";
import type { ItemPos, PhotoCamera, RoomGeometry } from "@db/schema";
import { applyStacking } from "@/lib/roomStacking";

export type PlanItem = {
  id: number;
  name: string;
  pos: ItemPos | null;
  /** false for an item rolled up from a cut sub-room into this overview -
   * selectable (confirm/reject work fine, they don't touch position) but
   * not draggable here, since a position edit would need to write back
   * through that sub-room's offset rather than this room's own frame. */
  editable?: boolean;
};

/** A photo standing on the plan: where it was taken and where it looks. */
export type CameraMarker = {
  /** the photo's id */
  id: number;
  title: string;
  camera: PhotoCamera;
  /** a suggestion drawn before it is placed: dashed, not interactive */
  ghost?: boolean;
};

/** A Thing a scan moved: an arrow from its old footprint centre to the new one. */
export type PlanMove = { from: ItemPos; to: ItemPos; label: string };

type Opening = RoomGeometry["openings"][number];
type CameraDrag = {
  kind: "move" | "aim";
  id: number;
  startLoc: { x: number; y: number };
  start: PhotoCamera;
  pending?: PhotoCamera;
};
type DragKind = "move" | "rotate" | "resize";
type DragState = { kind: DragKind; id: number; startLoc: { x: number; y: number }; startPos: ItemPos };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const round2 = (v: number) => +v.toFixed(2);
/** radius of a camera's view wedge, in metres */
const CAMERA_WEDGE_M = 1.2;
const CAMERA_FOV_MIN = 20;
const CAMERA_FOV_MAX = 120;
const normDeg = (d: number) => ((d % 360) + 360) % 360;


/**
 * 2D floor plan, to scale in meters - read-only render plus drag/rotate/
 * resize on placed items. Ported from lidarventory's render2D() (meter→
 * pixel grid via SVG CTM, edge-based opening placement, 15°-snap rotate,
 * unrotated-frame resize - same simplification the original uses: the
 * rotate/resize handles sit at the item's *unrotated* bounding box, so a
 * rotated item's resize is approximate, matching the source behavior).
 *
 * Drag math stays imperative for the hot path (direct attribute writes on
 * pointermove, matching the original) and only commits to the caller via
 * onPosChange on pointerup - re-rendering the whole SVG on every pointer
 * move would be the "drag-in-React tax" the rewrite estimate warned about.
 */
export function RoomPlan2D({
  widthM,
  depthM,
  walls,
  openings,
  items,
  editable = false,
  selectedId = null,
  onSelect,
  onPosChange,
  rotationDeg = 0,
  cutMode = false,
  onCutRect,
  pinMode = false,
  onPinPlace,
  cameras,
  selectedCameraId = null,
  onSelectCamera,
  onCameraChange,
  cameraMode = false,
  onCameraPlace,
  ghostWalls,
  moves,
}: {
  widthM: number;
  depthM: number;
  walls: RoomGeometry["walls"] | null;
  openings: RoomGeometry["openings"] | null;
  items: PlanItem[];
  editable?: boolean;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  onPosChange?: (id: number, pos: ItemPos) => void;
  /** Display-only orientation (0/90/180/270) - a viewing preference, not a
   * data change. Coordinate math (px/py, drag/rotate/resize) stays in the
   * original unrotated frame; getScreenCTM() already accounts for this CSS
   * transform when converting pointer positions back to that frame. */
  rotationDeg?: 0 | 90 | 180 | 270;
  /** When true, dragging on the floor draws a selection rectangle instead
   * of moving items (item pointerdown is ignored) - used to carve a named
   * sub-room out of a whole-floor geometry blob. */
  cutMode?: boolean;
  onCutRect?: (bounds: { xM: number; yM: number; wM: number; dM: number }) => void;
  /** When true, clicking empty floor "pins" a new item there instead of
   * doing nothing - the click just reports the meter position, the caller
   * (RoomPlan page) owns naming/creating it. */
  pinMode?: boolean;
  onPinPlace?: (pos: { xM: number; yM: number }) => void;
  /** Photos standing on the plan (dot + view wedge). Heading 0 = +x,
   * counter-clockwise seen from above, like an item's rotDeg. */
  cameras?: CameraMarker[];
  selectedCameraId?: number | null;
  onSelectCamera?: (id: number) => void;
  /** Called once on pointer-up after a marker was moved (dot), aimed (the
   * handle at the wedge's tip) or widened (shift + handle, 5° steps).
   * Without it the markers are select-only. */
  onCameraChange?: (id: number, camera: PhotoCamera) => void;
  /** When true, a floor click reports its position to onCameraPlace
   * (instead of onPinPlace): the caller stands a photo there. */
  cameraMode?: boolean;
  onCameraPlace?: (pos: { xM: number; yM: number }) => void;
  /** An earlier outline (a previous scan's walls), drawn dashed and faint
   * under the live walls. Display only. */
  ghostWalls?: RoomGeometry["walls"] | null;
  /** Arrows from where a Thing was to where it is now (a scan's moves).
   * Display only: they never take the pointer. */
  moves?: PlanMove[];
}) {
  const S = 70; // px per meter
  const PAD = 36;
  const svgW = widthM * S + PAD * 2;
  const svgH = depthM * S + PAD * 2;
  const px = (xM: number) => PAD + xM * S;
  const py = (yM: number) => PAD + yM * S;

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const cutStartRef = useRef<{ xM: number; yM: number } | null>(null);
  const [cutRect, setCutRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const camDragRef = useRef<CameraDrag | null>(null);
  // the marker being dragged, drawn from here until the caller's cameras
  // catch up (a camera drag re-renders: a handful of markers, not the
  // whole item set's hot path)
  const [camDraft, setCamDraft] = useState<{ id: number; camera: PhotoCamera } | null>(null);
  const floorMode = cutMode || pinMode || cameraMode;

  const xTicks = Array.from({ length: Math.floor(widthM) + 1 }, (_, i) => i);
  const yTicks = Array.from({ length: Math.floor(depthM) + 1 }, (_, i) => i);
  const placed = items.filter((it): it is PlanItem & { pos: ItemPos } => it.pos != null);
  const selected = placed.find((it) => it.id === selectedId);

  const openingLine = (o: Opening) => {
    const a = o.offsetM, b = o.offsetM + o.widthM;
    if (o.edge === "bottom") return { x1: px(a), y1: py(depthM), x2: px(b), y2: py(depthM) };
    if (o.edge === "top") return { x1: px(a), y1: py(0), x2: px(b), y2: py(0) };
    if (o.edge === "left") return { x1: px(0), y1: py(a), x2: px(0), y2: py(b) };
    return { x1: px(widthM), y1: py(a), x2: px(widthM), y2: py(b) };
  };

  const toLocal = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM()!.inverse());
  };

  const placeItemGroup = (id: number, p: ItemPos) => {
    const svg = svgRef.current;
    const g = svg?.querySelector<SVGGElement>(`g[data-item-id="${id}"]`);
    if (!g) return;
    const x = px(p.xM), y = py(p.yM), w = p.wM * S, d = p.dM * S;
    g.setAttribute("transform", `rotate(${-p.rotDeg} ${x + w / 2} ${y + d / 2})`);
    g.querySelector("rect")?.setAttribute("x", String(x));
    g.querySelector("rect")?.setAttribute("y", String(y));
    g.querySelector("rect")?.setAttribute("width", String(w));
    g.querySelector("rect")?.setAttribute("height", String(d));
    const text = g.querySelector("text");
    text?.setAttribute("x", String(x + w / 2));
    text?.setAttribute("y", String(y + d / 2 + 4));
    text?.setAttribute("transform", `rotate(${p.rotDeg - rotationDeg} ${x + w / 2} ${y + d / 2 + 4})`);
  };

  const startDrag = (kind: DragKind, id: number, e: React.PointerEvent) => {
    if (!editable) return;
    const it = placed.find((p) => p.id === id);
    if (!it || it.editable === false) return;
    onSelect?.(id);
    dragRef.current = { kind, id, startLoc: toLocal(e.clientX, e.clientY), startPos: { ...it.pos } };
    (e.target as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  const handlePinClick = (e: React.MouseEvent) => {
    if (!pinMode && !cameraMode) return;
    const loc = toLocal(e.clientX, e.clientY);
    const at = {
      xM: round2(clamp((loc.x - PAD) / S, 0, widthM)),
      yM: round2(clamp((loc.y - PAD) / S, 0, depthM)),
    };
    if (cameraMode) onCameraPlace?.(at);
    else onPinPlace?.(at);
  };

  const startCameraDrag = (kind: CameraDrag["kind"], marker: CameraMarker, e: React.PointerEvent) => {
    if (floorMode || marker.ghost) return;
    onSelectCamera?.(marker.id);
    e.stopPropagation();
    if (!onCameraChange) return;
    camDragRef.current = { kind, id: marker.id, startLoc: toLocal(e.clientX, e.clientY), start: { ...marker.camera } };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const startCut = (e: React.PointerEvent) => {
    if (!cutMode) return;
    const loc = toLocal(e.clientX, e.clientY);
    const xM = clamp((loc.x - PAD) / S, 0, widthM), yM = clamp((loc.y - PAD) / S, 0, depthM);
    cutStartRef.current = { xM, yM };
    setCutRect({ x0: xM, y0: yM, x1: xM, y1: yM });
    (e.target as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (cutStartRef.current) {
      const loc = toLocal(e.clientX, e.clientY);
      const xM = clamp((loc.x - PAD) / S, 0, widthM), yM = clamp((loc.y - PAD) / S, 0, depthM);
      setCutRect({ x0: cutStartRef.current.xM, y0: cutStartRef.current.yM, x1: xM, y1: yM });
      return;
    }
    const camDrag = camDragRef.current;
    if (camDrag) {
      const loc = toLocal(e.clientX, e.clientY);
      const next = { ...camDrag.start };
      if (camDrag.kind === "move") {
        next.xM = round2(clamp(camDrag.start.xM + (loc.x - camDrag.startLoc.x) / S, 0, widthM));
        next.yM = round2(clamp(camDrag.start.yM + (loc.y - camDrag.startLoc.y) / S, 0, depthM));
      } else {
        // screen y grows down the plan: a direction (dx, dy) is atan2(-dy, dx)
        const angleAt = (p: { x: number; y: number }) =>
          (Math.atan2(-(p.y - py(camDrag.start.yM)), p.x - px(camDrag.start.xM)) * 180) / Math.PI;
        const offOf = (deg: number) => Math.abs(((normDeg(deg - camDrag.start.headingDeg) + 180) % 360) - 180);
        const a = angleAt(loc);
        if (e.shiftKey) {
          // the handle drags an edge of the wedge: the fov grows by twice the
          // angle gained off the heading since the drag began, so a press
          // without moving keeps the fov
          const fov = camDrag.start.fovDeg + 2 * (offOf(a) - offOf(angleAt(camDrag.startLoc)));
          next.fovDeg = clamp(Math.round(fov / 5) * 5, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
        } else {
          next.headingDeg = normDeg(Math.round(a));
        }
      }
      camDrag.pending = next;
      setCamDraft({ id: camDrag.id, camera: next });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const loc = toLocal(e.clientX, e.clientY);
    const next = { ...drag.startPos };

    if (drag.kind === "move") {
      const dx = (loc.x - drag.startLoc.x) / S, dy = (loc.y - drag.startLoc.y) / S;
      next.xM = round2(clamp(drag.startPos.xM + dx, 0, widthM - drag.startPos.wM));
      next.yM = round2(clamp(drag.startPos.yM + dy, 0, depthM - drag.startPos.dM));
    } else if (drag.kind === "resize") {
      next.wM = Math.max(0.1, round2((loc.x - PAD) / S - drag.startPos.xM));
      next.dM = Math.max(0.1, round2((loc.y - PAD) / S - drag.startPos.yM));
    } else {
      const cx = px(drag.startPos.xM + drag.startPos.wM / 2);
      const cy = py(drag.startPos.yM + drag.startPos.dM / 2);
      const a = (Math.atan2(loc.y - cy, loc.x - cx) * 180) / Math.PI;
      const rot = (((-(a + 90)) % 360) + 360) % 360;
      next.rotDeg = e.shiftKey ? +rot.toFixed(1) : Math.round(rot / 15) * 15 % 360;
    }

    (drag as DragState & { pending?: ItemPos }).pending = next;
    placeItemGroup(drag.id, next);
  };

  const onDragEnd = () => {
    if (cutStartRef.current) {
      const rect = cutRect;
      cutStartRef.current = null;
      setCutRect(null);
      if (!rect) return;
      const xM = round2(Math.min(rect.x0, rect.x1)), yM = round2(Math.min(rect.y0, rect.y1));
      const wM = round2(Math.abs(rect.x1 - rect.x0)), dM = round2(Math.abs(rect.y1 - rect.y0));
      if (wM > 0.2 && dM > 0.2) onCutRect?.({ xM, yM, wM, dM });
      return;
    }
    const camDrag = camDragRef.current;
    if (camDrag) {
      camDragRef.current = null;
      setCamDraft(null);
      if (camDrag.pending) onCameraChange?.(camDrag.id, camDrag.pending);
      return;
    }
    const drag = dragRef.current as (DragState & { pending?: ItemPos }) | null;
    dragRef.current = null;
    if (!drag?.pending) return;
    const pos = drag.kind === "move" ? applyStacking(drag.id, drag.pending, placed) : drag.pending;
    onPosChange?.(drag.id, pos);
  };

  /** The browser took the pointer away (a touch scroll, a system gesture):
   * drop every drag without writing anything. */
  const onDragCancel = () => {
    cutStartRef.current = null;
    setCutRect(null);
    camDragRef.current = null;
    setCamDraft(null);
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) placeItemGroup(drag.id, drag.startPos);
  };

  return (
    <div className="w-full flex items-center justify-center overflow-hidden rounded-lg border border-border bg-white" style={{ aspectRatio: "1 / 1" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgW} ${svgH}`}
        width={svgW}
        height={svgH}
        style={{ maxWidth: "100%", maxHeight: "100%", transform: `rotate(${rotationDeg}deg)`, transformOrigin: "center" }}
        className="touch-none"
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragCancel}
      >
      {xTicks.map((x) => (
        <text
          key={`x${x}`}
          x={px(x)}
          y={PAD - 10}
          transform={`rotate(${-rotationDeg} ${px(x)} ${PAD - 10})`}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          {x}m
        </text>
      ))}
      {yTicks.map((y) => (
        <text
          key={`y${y}`}
          x={PAD - 8}
          y={py(y) + 3}
          transform={`rotate(${-rotationDeg} ${PAD - 8} ${py(y) + 3})`}
          textAnchor="end"
          className="fill-muted-foreground text-[9px]"
        >
          {y}m
        </text>
      ))}

      <rect
        x={PAD}
        y={PAD}
        width={widthM * S}
        height={depthM * S}
        className={`fill-muted/20 stroke-border ${floorMode ? "cursor-crosshair" : ""}`}
        strokeWidth={1}
        onPointerDown={startCut}
        onClick={handlePinClick}
      />

      {(ghostWalls ?? []).map((wall, i) => (
        <polyline
          key={`ghost-${i}`}
          points={wall.points.map(([x, y]) => `${px(x)},${py(y)}`).join(" ")}
          stroke="#64748b"
          strokeOpacity={0.45}
          strokeWidth={2}
          strokeDasharray="5 4"
          fill="none"
          pointerEvents="none"
        />
      ))}

      {(walls ?? []).map((wall, i) => {
        const kind = wall.kind ?? "wall";
        const points = wall.points.map(([x, y]) => `${px(x)},${py(y)}`).join(" ");
        if (kind === "door") {
          return <polyline key={i} points={points} stroke="#d9a13b" strokeWidth={2} strokeDasharray="6 4" fill="none" />;
        }
        if (kind === "window") {
          return <polyline key={i} points={points} stroke="#4da3ff" strokeWidth={3} fill="none" />;
        }
        return <polyline key={i} points={points} className="stroke-foreground/60" strokeWidth={3} fill="none" />;
      })}

      {(openings ?? []).map((o, i) => {
        const { x1, y1, x2, y2 } = openingLine(o);
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-background" strokeWidth={4} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d9a13b" strokeWidth={2} strokeDasharray="6 4" />
            <text
              x={(x1 + x2) / 2}
              y={Math.max(y1, y2) + (o.edge === "bottom" ? 14 : -6)}
              transform={`rotate(${-rotationDeg} ${(x1 + x2) / 2} ${Math.max(y1, y2) + (o.edge === "bottom" ? 14 : -6)})`}
              textAnchor="middle"
              fill="#d9a13b"
              className="text-[9px]"
            >
              opening · {o.widthM} m{o.connectsTo != null ? ` → room #${o.connectsTo}` : ""}
            </text>
          </g>
        );
      })}

      {placed.map((it) => {
        const p = it.pos;
        const x = px(p.xM), y = py(p.yM), w = p.wM * S, d = p.dM * S;
        const isSel = it.id === selectedId;
        return (
          <g
            key={it.id}
            data-item-id={it.id}
            transform={`rotate(${-p.rotDeg} ${x + w / 2} ${y + d / 2})`}
            onPointerDown={(e) => {
              if (floorMode) return;
              if (editable && it.editable !== false) startDrag("move", it.id, e);
              else onSelect?.(it.id);
            }}
            onClick={handlePinClick}
            className={floorMode ? "" : editable && it.editable !== false ? "cursor-move" : "cursor-pointer"}
          >
            <rect
              x={x}
              y={y}
              width={w}
              height={d}
              rx={4}
              className={isSel ? "fill-primary/25 stroke-primary" : "fill-primary/15 stroke-primary/70"}
              strokeWidth={isSel ? 2 : 1.5}
              strokeDasharray={it.editable === false ? "4 2" : undefined}
            />
            <text
              x={x + w / 2}
              y={y + d / 2 + 4}
              transform={`rotate(${p.rotDeg - rotationDeg} ${x + w / 2} ${y + d / 2 + 4})`}
              textAnchor="middle"
              className="text-[10px] fill-foreground"
            >
              {it.name}
              {p.baseM ? " ↑" : ""}
            </text>
          </g>
        );
      })}

      {(moves ?? []).map((m, i) => {
        const centre = (p: ItemPos) => ({ x: px(p.xM + p.wM / 2), y: py(p.yM + p.dM / 2) });
        const a = centre(m.from), b = centre(m.to);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 2) return null;
        // arrowhead drawn by hand (no <marker>: its id would have to be unique per plan)
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const H = 9, Wd = 4.5;
        const head = `${b.x},${b.y} ${b.x - ux * H - uy * Wd},${b.y - uy * H + ux * Wd} ${b.x - ux * H + uy * Wd},${b.y - uy * H - ux * Wd}`;
        const color = "#ea580c";
        return (
          <g key={`move-${i}`} pointerEvents="none">
            <title>{m.label}</title>
            <circle cx={a.x} cy={a.y} r={3} fill="white" stroke={color} strokeWidth={1.5} />
            <line x1={a.x} y1={a.y} x2={b.x - ux * (H - 1)} y2={b.y - uy * (H - 1)} stroke={color} strokeWidth={2} strokeDasharray="4 2" />
            <polygon points={head} fill={color} />
          </g>
        );
      })}

      {(cameras ?? []).map((m) => {
        const cam = camDraft?.id === m.id ? camDraft.camera : m.camera;
        const cx = px(clamp(cam.xM, 0, widthM)), cy = py(clamp(cam.yM, 0, depthM));
        const R = CAMERA_WEDGE_M * S;
        const at = (deg: number) => {
          const r = (deg * Math.PI) / 180;
          return { x: cx + R * Math.cos(r), y: cy - R * Math.sin(r) };
        };
        const a1 = at(cam.headingDeg - cam.fovDeg / 2);
        const a2 = at(cam.headingDeg + cam.fovDeg / 2);
        const tip = at(cam.headingDeg);
        const isSel = !m.ghost && m.id === selectedCameraId;
        const live = !m.ghost && !floorMode;
        const color = "#7c3aed";
        return (
          <g
            key={`cam-${m.id}${m.ghost ? "-ghost" : ""}`}
            data-camera-id={m.id}
            pointerEvents={live ? undefined : "none"}
            opacity={m.ghost ? 0.6 : 1}
          >
            <title>{m.title}</title>
            {/* sweep 0: counter-clockwise on screen, the way the heading grows */}
            <path
              d={`M ${cx} ${cy} L ${a1.x} ${a1.y} A ${R} ${R} 0 0 0 ${a2.x} ${a2.y} Z`}
              fill={color}
              fillOpacity={isSel ? 0.22 : 0.12}
              stroke={color}
              strokeOpacity={isSel ? 0.9 : 0.5}
              strokeWidth={isSel ? 2 : 1}
              strokeDasharray={m.ghost ? "5 3" : undefined}
              className={live ? "cursor-pointer" : ""}
              onPointerDown={(e) => {
                if (!live) return;
                onSelectCamera?.(m.id);
                e.stopPropagation();
              }}
            />
            <circle
              cx={cx}
              cy={cy}
              r={5}
              fill={m.ghost ? "white" : color}
              stroke={isSel ? "#1e1b4b" : color}
              strokeWidth={isSel ? 2.5 : 1.5}
              strokeDasharray={m.ghost ? "3 2" : undefined}
              className={live ? (onCameraChange ? "cursor-move" : "cursor-pointer") : ""}
              onPointerDown={(e) => startCameraDrag("move", m, e)}
            />
            {isSel && onCameraChange && (
              <>
                <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke={color} strokeWidth={1} strokeDasharray="3 2" />
                <circle
                  cx={tip.x}
                  cy={tip.y}
                  r={6}
                  className="fill-white cursor-grab"
                  stroke={color}
                  strokeWidth={2}
                  onPointerDown={(e) => startCameraDrag("aim", m, e)}
                >
                  <title>Drag to aim · shift-drag to widen or narrow the view</title>
                </circle>
              </>
            )}
          </g>
        );
      })}

      {cutRect && (
        <rect
          x={px(Math.min(cutRect.x0, cutRect.x1))}
          y={py(Math.min(cutRect.y0, cutRect.y1))}
          width={Math.abs(cutRect.x1 - cutRect.x0) * S}
          height={Math.abs(cutRect.y1 - cutRect.y0) * S}
          className="fill-emerald-500/10 stroke-emerald-600"
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      )}

      {editable && selected && selected.editable !== false && (
        <>
          {(() => {
            const p = selected.pos;
            const x = px(p.xM), y = py(p.yM), w = p.wM * S, d = p.dM * S;
            return (
              <>
                <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y - 16} stroke="#4da3ff" strokeWidth={1} />
                <circle
                  cx={x + w / 2}
                  cy={y - 16}
                  r={7}
                  className="fill-white stroke-[#4da3ff] cursor-grab"
                  strokeWidth={2}
                  onPointerDown={(e) => startDrag("rotate", selected.id, e)}
                />
                <rect
                  x={x + w - 6}
                  y={y + d - 6}
                  width={12}
                  height={12}
                  className="fill-white stroke-[#4da3ff] cursor-se-resize"
                  strokeWidth={2}
                  onPointerDown={(e) => startDrag("resize", selected.id, e)}
                />
              </>
            );
          })()}
        </>
      )}
      </svg>
    </div>
  );
}
