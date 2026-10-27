/**
 * How the Workbench turns a stored model3dUrl into something the viewer
 * can fetch, and how it classifies the file. Shared with tests; no three.js.
 */

export const MODEL3D_FORMATS = ["glb", "gltf", "usdz", "js"] as const;
export type Model3dFormat = (typeof MODEL3D_FORMATS)[number];
export type Model3dFormatOrUnknown = Model3dFormat | "unknown";

export function hasModel3dUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.trim().length > 0;
}

/** Same-origin path the browser can GET, or the remote http(s) URL as stored. */
export function resolveModel3dSrc(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("local/")) return `/uploads/${s.slice("local/".length)}`;
  if (s.startsWith("/uploads/")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

export function model3dFormatOf(url: string): Model3dFormatOrUnknown {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".glb")) return "glb";
  if (path.endsWith(".gltf")) return "gltf";
  if (path.endsWith(".usdz")) return "usdz";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "js";
  return "unknown";
}

/** Companion Thing page. Base comes from Settings / HOMEBASE_3D_URL. */
export function homebase3dThingUrl(base: string | null | undefined, itemId: number): string | null {
  if (!base) return null;
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  return `${trimmed}/things/${itemId}`;
}

/**
 * Route-1 modules are `export function build(THREE)` (optionally async).
 * A light static check before we import() the fetched source — not a sandbox.
 */
export function looksLikeAgentModelModule(source: string): boolean {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return (
    /\bexport\s+(?:async\s+)?function\s+build\s*\(/.test(stripped) ||
    /\bexport\s*\{[^}]*\bbuild\b[^}]*\}/.test(stripped)
  );
}

export const MODEL3D_VIEW_COPY = {
  loading: "Loading 3D model…",
  missing: "No model file yet — homebase-3d can write one later.",
  unsupported: "This model format cannot be shown here.",
  unreachable: "The 3D model could not be reached.",
  parse: "The 3D model could not be read.",
  agent: "The agent module failed to load or threw.",
  usdz: "USDZ cannot be previewed in this browser. Download the file to open it.",
  openCompanion: "Open in homebase-3d",
  download: "Download",
  hasModel: "3D",
  filterHasModel: "Has 3D",
} as const;
