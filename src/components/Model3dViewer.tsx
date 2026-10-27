import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js";
import {
  looksLikeAgentModelModule,
  MODEL3D_VIEW_COPY,
  model3dFormatOf,
  type Model3dFormatOrUnknown,
} from "@/lib/model3dView";

export type Model3dViewerProps = {
  src: string;
  className?: string;
};

type FailKind = "unsupported" | "unreachable" | "parse" | "agent" | "usdz";

/**
 * Small orbit/zoom viewer. Loaded only from the Thing detail page, and only
 * when a model URL exists — three.js stays out of the rest of the Workbench.
 * Metres and Y-up as stored; the camera frames the object, we do not scale it.
 */
export function Model3dViewer({ src, className }: Model3dViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [fail, setFail] = useState<{ kind: FailKind; detail?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let cancelled = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f1ea);
    const loaded: THREE.Object3D[] = [];

    const failWith = (kind: FailKind, detail?: string) => {
      if (!cancelled) setFail({ kind, detail });
    };

    const disposeObject = (obj: THREE.Object3D) => {
      obj.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (!mat) return;
        const list = Array.isArray(mat) ? mat : [mat];
        for (const m of list) {
          const std = m as THREE.MeshStandardMaterial;
          std.map?.dispose();
          std.normalMap?.dispose();
          std.roughnessMap?.dispose();
          std.metalnessMap?.dispose();
          std.emissiveMap?.dispose();
          m.dispose();
        }
      });
    };

    const fit = (camera: THREE.PerspectiveCamera, orbit: OrbitControls, object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.05);
      const fov = (camera.fov * Math.PI) / 180;
      const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.7;
      camera.near = Math.max(dist / 200, 0.01);
      camera.far = Math.max(dist * 80, 50);
      camera.position.set(center.x + dist * 0.72, center.y + dist * 0.55, center.z + dist * 0.72);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      orbit.target.copy(center);
      orbit.minDistance = maxDim * 0.25;
      orbit.maxDistance = dist * 10;
      orbit.update();
    };

    const show = (object: THREE.Object3D) => {
      if (cancelled) {
        disposeObject(object);
        return;
      }
      scene.add(object);
      loaded.push(object);
      if (camera && controls) fit(camera, controls, object);
      setLoading(false);
    };

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;

    scene.add(new THREE.HemisphereLight(0xf4f1ea, 0x8a8370, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.4, 4.2, 2.8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8e4d8, 0.45);
    fill.position.set(-2.2, 1.6, -1.4);
    scene.add(fill);

    const resize = () => {
      if (!renderer) return;
      const w = el.clientWidth;
      const h = el.clientHeight || w;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    ro = new ResizeObserver(resize);
    ro.observe(el);

    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls?.update();
      if (renderer) renderer.render(scene, camera);
    };
    loop();

    const format = model3dFormatOf(src);
    void loadObject(src, format)
      .then(show)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/unsupport|format/i.test(message)) failWith("unsupported", message);
        else if (/HTTP|fetch|network|Failed to fetch|CORS/i.test(message)) failWith("unreachable", message);
        else if (format === "js") failWith("agent", message);
        else if (format === "usdz") failWith("usdz", message);
        else failWith("parse", message);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      controls?.dispose();
      for (const obj of loaded) {
        scene.remove(obj);
        disposeObject(obj);
      }
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, [src]);

  const copy =
    fail?.kind === "usdz"
      ? MODEL3D_VIEW_COPY.usdz
      : fail?.kind === "agent"
        ? MODEL3D_VIEW_COPY.agent
        : fail?.kind === "unreachable"
          ? MODEL3D_VIEW_COPY.unreachable
          : fail?.kind === "unsupported"
            ? MODEL3D_VIEW_COPY.unsupported
            : fail
              ? MODEL3D_VIEW_COPY.parse
              : null;

  return (
    <div className={className ?? "relative h-56 w-full overflow-hidden rounded-md border border-border bg-[#f4f1ea]"}>
      <div ref={boxRef} className="absolute inset-0" />
      {loading && !fail && (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">{MODEL3D_VIEW_COPY.loading}</div>
      )}
      {fail && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#f4f1ea]/90 px-3 text-center">
          <p className="text-[12px] text-muted-foreground">{copy}</p>
          {fail.kind === "usdz" && (
            <a href={src} download className="text-[12px] text-primary hover:underline">
              {MODEL3D_VIEW_COPY.download}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default Model3dViewer;

async function loadObject(src: string, format: Model3dFormatOrUnknown): Promise<THREE.Object3D> {
  if (format === "unknown") throw new Error("unsupported format");
  if (format === "js") return loadAgentModule(src);
  if (format === "usdz") return loadUsdz(src);
  return loadGltf(src);
}

async function loadGltf(src: string): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  loader.setCrossOrigin("anonymous");
  const gltf = await loader.loadAsync(src);
  return gltf.scene;
}

async function loadUsdz(src: string): Promise<THREE.Object3D> {
  const loader = new USDLoader();
  loader.setCrossOrigin("anonymous");
  return loader.loadAsync(src);
}

/**
 * Fetch the module (CORS required), check it looks like `build(THREE)`, then
 * import() from a blob URL. The code still runs in this page — we do not eval
 * it, and we do not give it anything but the THREE namespace.
 */
async function loadAgentModule(src: string): Promise<THREE.Object3D> {
  let res: Response;
  try {
    res = await fetch(src, { credentials: "omit", mode: "cors", cache: "no-cache" });
  } catch {
    throw new Error("Failed to fetch agent module (CORS or network).");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const source = await res.text();
  if (!looksLikeAgentModelModule(source)) {
    throw new Error("Not an agent model module (missing export function build).");
  }
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as { build?: unknown };
    if (typeof mod.build !== "function") throw new Error("Module has no build() export.");
    let built: unknown;
    try {
      built = await (mod.build as (three: typeof THREE) => unknown)(THREE);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "build() threw");
    }
    if (!isObject3D(built)) throw new Error("build() did not return a Three.js object.");
    return built;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function isObject3D(value: unknown): value is THREE.Object3D {
  return !!value && typeof value === "object" && (value as THREE.Object3D).isObject3D === true;
}
