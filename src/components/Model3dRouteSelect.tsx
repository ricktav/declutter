import { MODEL3D_ROUTE_LABELS, model3dRouteLabel, type Model3dRoute } from "@db/model3d";
import type { Attrs } from "@db/taxonomy";
import { cn } from "@/lib/utils";

const MANUAL = ["none", "agent", "meshy", "capture"] as const;

/** Small route picker. Auto shows the resolved Meshy / Object Capture label. */
export function Model3dRouteSelect({
  route,
  attributes,
  onChange,
  disabled,
  className,
  /** Batch bar: one Auto for mixed favourites. Per-row / detail: resolved. */
  autoMode = "resolved",
}: {
  route: Model3dRoute;
  attributes?: Attrs;
  onChange: (route: Model3dRoute) => void;
  disabled?: boolean;
  className?: string;
  autoMode?: "resolved" | "plain";
}) {
  const autoText = autoMode === "plain" ? "Auto" : model3dRouteLabel("auto", attributes ?? null);
  return (
    <select
      className={cn("rounded-md border border-input bg-white px-1.5 py-1 text-[12px] max-w-[11rem]", className)}
      value={route}
      disabled={disabled}
      aria-label="3D model route"
      title="How this Thing gets a 3D model"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as Model3dRoute)}
    >
      <option value="auto">{autoText}</option>
      {MANUAL.map((r) => (
        <option key={r} value={r}>
          {MODEL3D_ROUTE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}
