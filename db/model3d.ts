/**
 * How a Thing gets a 3D model. Shared by the API and the Workbench.
 * HomeBase stores the choice; homebase-3d (and later Meshy / Object Capture /
 * an agent) produce the file.
 */
import { attrStr, type Attrs } from "./taxonomy";
import { MODEL3D_ROUTES, type EffectiveModel3dRoute, type Model3dRoute } from "./schema";

export { MODEL3D_ROUTES, type EffectiveModel3dRoute, type Model3dRoute };

/** Favourite Things get Apple Object Capture when the route is `auto`. */
export function isFavouriteThing(attributes: Attrs): boolean {
  const v = (attrStr(attributes, "favourite") ?? attrStr(attributes, "favorite") ?? "").trim().toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

export function effectiveModel3dRoute(route: Model3dRoute | null | undefined, attributes: Attrs): EffectiveModel3dRoute {
  const r = route ?? "auto";
  if (r !== "auto") return r;
  return isFavouriteThing(attributes) ? "capture" : "meshy";
}

/** Dropdown / list label. Auto shows the resolved destination. */
export function model3dRouteLabel(route: Model3dRoute | null | undefined, attributes: Attrs): string {
  const stored = route ?? "auto";
  if (stored === "auto") {
    return effectiveModel3dRoute("auto", attributes) === "capture" ? "Auto (Object Capture)" : "Auto (Meshy)";
  }
  return MODEL3D_ROUTE_LABELS[stored];
}

export const MODEL3D_ROUTE_LABELS: Record<EffectiveModel3dRoute, string> = {
  none: "None",
  agent: "Agent",
  meshy: "Meshy",
  capture: "Object Capture",
};

/** A stored path under /uploads, a local/ key, or an http(s) URL to a .glb / .usdz / .js module. */
export function parseModel3dUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.length > 512) throw new Error("model3dUrl is too long.");
  if (/\s/.test(s) || /[\u0000-\u001F]/.test(s)) throw new Error("model3dUrl must be a path or URL.");
  if (s.startsWith("/uploads/") || s.startsWith("local/")) return s;
  if (/^https?:\/\//i.test(s)) {
    if (!/\.(glb|usdz|js)(\?|#|$)/i.test(s)) throw new Error("A remote model3dUrl must point at a .glb, .usdz or .js file.");
    return s;
  }
  throw new Error("model3dUrl must be /uploads/…, local/…, or an http(s) URL to a .glb / .usdz / .js file.");
}
