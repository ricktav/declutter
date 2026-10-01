import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RoomGeometry } from "@db/schema";
import type { PlanItem } from "./RoomPlan2D";

const DEFAULT_WALL_HEIGHT = 2.4;
const ITEM_COLOR = 0x5a7a52; // matches the app's moss-green primary
const ITEM_COLOR_ROLLUP = 0x9aa89a;

/**
 * 3D twin of the same room data RoomPlan2D renders - parametric boxes for
 * walls/items (no real meshes, that's a later "attach a GLB" phase like
 * lidarventory's), imperatively managed Three.js inside one ref+effect
 * rather than react-three-fiber. Per the rewrite-estimate doc's Option A:
 * this scene is one frequently-repositioned object graph driven by pointer
 * interaction, which is r3f's weaker case, and plain three.js here ports
 * lidarventory's buildRoom3D()/attachModel3D() almost unchanged.
 */
export function RoomPlan3D({
  widthM,
  depthM,
  wallHeightM,
  walls,
  items,
  selectedId = null,
  onSelect,
  pinMode = false,
  onPinPlace,
  active = true,
}: {
  widthM: number;
  depthM: number;
  wallHeightM: number | null;
  walls: RoomGeometry["walls"] | null;
  items: PlanItem[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  pinMode?: boolean;
  onPinPlace?: (pos: { xM: number; yM: number }) => void;
  /** True while this view's tab is the visible one. A `hidden` ancestor
   * going display:none -> block doesn't reliably fire ResizeObserver (the
   * element is 0x0 the whole time it's hidden, so there's nothing to
   * "resize" from the browser's perspective) - this flag drives an explicit
   * resize instead, or the canvas stays stuck at its initial 0x0 size. */
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const roomGroupRef = useRef<THREE.Group | null>(null);
  const itemMeshesRef = useRef<THREE.Mesh[]>([]);
  const framedKeyRef = useRef<string | null>(null);
  const pinModeRef = useRef(pinMode);
  pinModeRef.current = pinMode;

  // one-time scene/camera/renderer/controls setup
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // a fresh camera instance always needs framing once, even if the
    // rebuild effect already framed a *previous* instance at these same
    // dimensions (StrictMode's dev-only double-invoke recreates the camera
    // without resetting this ref, which otherwise leaves the new camera
    // stuck at its default (0,0,0) position)
    framedKeyRef.current = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f1ea);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    el.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.6, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.1);
    dl.position.set(3, 6, 4);
    scene.add(dl);
    const grid = new THREE.GridHelper(20, 20, 0xcfc9b8, 0xe4e0d4);
    grid.position.y = -0.03;
    scene.add(grid);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight || w;
      if (w === 0 || h === 0) return; // hidden tab - the `active` effect handles sizing once shown
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const setPtr = (clientX: number, clientY: number) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((clientY - r.top) / r.height) * 2 + 1;
    };
    // OrbitControls drags fire a "click" at mouseup same as a real click does
    // (native click doesn't care how far the mouse moved) - only treat it as
    // a click/pin if the mouse barely moved, or every orbit drag would also
    // select/place something underneath it. Listening on mousedown+click
    // rather than pointerdown+pointerup: synthetic single-click input (as
    // opposed to a real press-move-release drag) doesn't reliably produce
    // PointerEvents, but always produces a "click".
    let downPos: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return;
      setPtr(e.clientX, e.clientY);
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects(itemMeshesRef.current)[0];
      if (hit) {
        onSelect?.(hit.object.userData.id as number);
        return;
      }
      if (!pinModeRef.current) return;
      const roomGroup = roomGroupRef.current;
      if (!roomGroup) return;
      const v = new THREE.Vector3();
      if (!ray.ray.intersectPlane(floorPlane, v)) return;
      const { widthM: w, depthM: d } = roomGroup.userData as { widthM: number; depthM: number };
      const xM = v.x + w / 2, yM = v.z + d / 2;
      if (xM < 0 || xM > w || yM < 0 || yM > d) return;
      onPinPlace?.({ xM: +xM.toFixed(2), yM: +yM.toFixed(2) });
    };
    renderer.domElement.addEventListener("mousedown", onDown);
    renderer.domElement.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("mousedown", onDown);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // force a resize when this tab becomes the visible one (see `active` doc)
  useEffect(() => {
    if (!active) return;
    const el = containerRef.current, renderer = rendererRef.current, camera = cameraRef.current;
    if (!el || !renderer || !camera) return;
    const w = el.clientWidth, h = el.clientHeight || w;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }, [active]);

  // rebuild the room whenever geometry or items change
  useEffect(() => {
    const scene = sceneRef.current, camera = cameraRef.current, controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    if (roomGroupRef.current) scene.remove(roomGroupRef.current);
    const W = widthM, D = depthM, WH = wallHeightM ?? DEFAULT_WALL_HEIGHT;
    const roomGroup = new THREE.Group();
    roomGroup.userData = { widthM: W, depthM: D };
    scene.add(roomGroup);
    roomGroupRef.current = roomGroup;
    itemMeshesRef.current = [];

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(W, 0.05, D),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    floor.position.set(0, -0.025, 0);
    roomGroup.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8370, transparent: true, opacity: 0.5 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0xd9a13b, transparent: true, opacity: 0.35 });
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.35 });
    for (const wall of walls ?? []) {
      const mat = wall.kind === "door" ? doorMat : wall.kind === "window" ? windowMat : wallMat;
      for (let i = 0; i < wall.points.length - 1; i++) {
        const [x0, y0] = wall.points[i], [x1, y1] = wall.points[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.01) continue;
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, WH, 0.1), mat);
        mesh.position.set((x0 + x1) / 2 - W / 2, WH / 2, (y0 + y1) / 2 - D / 2);
        mesh.rotation.y = -angle;
        roomGroup.add(mesh);
      }
    }

    for (const it of items) {
      if (!it.pos) continue;
      const p = it.pos;
      const h = p.hM ?? 0.8;
      const color = it.editable === false ? ITEM_COLOR_ROLLUP : ITEM_COLOR;
      const mat = new THREE.MeshStandardMaterial({
        color,
        transparent: it.editable === false,
        opacity: it.editable === false ? 0.55 : 1,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.wM, h, p.dM), mat);
      mesh.position.set(
        p.xM + p.wM / 2 - W / 2,
        (p.baseM ?? 0) + h / 2,
        p.yM + p.dM / 2 - D / 2,
      );
      mesh.rotation.y = THREE.MathUtils.degToRad(p.rotDeg);
      mesh.userData.id = it.id;
      roomGroup.add(mesh);
      itemMeshesRef.current.push(mesh);
    }

    // Only frame the camera the first time this room's dimensions are seen -
    // items re-render on every selection/pin (a new array each time), and
    // resetting the camera on every one of those would fight the user's own
    // orbiting mid-interaction.
    if (framedKeyRef.current !== `${W}x${D}`) {
      framedKeyRef.current = `${W}x${D}`;
      camera.position.set(W * 0.9, Math.max(W, D) * 0.7 + 1, D * 1.3);
      controls.target.set(0, 0.6, 0);
      controls.update();
    }
  }, [widthM, depthM, wallHeightM, walls, items]);

  // selection highlight
  useEffect(() => {
    for (const m of itemMeshesRef.current) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const isSel = m.userData.id === selectedId;
      mat.emissive = new THREE.Color(isSel ? 0x4da3ff : 0x000000);
      mat.emissiveIntensity = isSel ? 0.5 : 0;
    }
  }, [selectedId, items]);

  return (
    <div
      ref={containerRef}
      className={`w-full aspect-square rounded-lg border border-border overflow-hidden ${pinMode ? "cursor-crosshair" : ""}`}
    />
  );
}

