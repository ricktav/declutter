import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { projectGeojsonFloor, type GeojsonWall } from "@/lib/geojsonFloor";

const WALL_COLOR: Record<GeojsonWall["kind"], string> = {
  wall: "#8a8370",
  door: "#d9a13b",
  window: "#4da3ff",
};

/** Small top-down wall-outline preview for a .geojson floor-scan capture,
 * rendered client-side from the raw file instead of a generic file icon -
 * uses the same projection math the eventual room import uses, so the
 * shape previewed here matches what you'd actually get. */
export function GeojsonThumb({ storageKey }: { storageKey: string }) {
  const url = trpc.attachments.url.useQuery({ key: storageKey });
  const [walls, setWalls] = useState<GeojsonWall[] | null>(null);
  const [dims, setDims] = useState<{ widthM: number; depthM: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url.data?.url) return;
    let cancelled = false;
    fetch(url.data.url)
      .then((r) => r.json())
      .then((geojson) => {
        if (cancelled) return;
        const proj = projectGeojsonFloor(geojson);
        if (!proj) {
          setFailed(true);
          return;
        }
        setWalls(proj.walls);
        setDims({ widthM: proj.widthM, depthM: proj.depthM });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url.data?.url]);

  if (failed) {
    return (
      <div className="aspect-square w-full flex items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
        <Boxes className="h-5 w-5" />
      </div>
    );
  }
  if (!walls || !dims) {
    return <div className="aspect-square w-full rounded-md border border-border bg-muted/40 animate-pulse" />;
  }

  const SIZE = 100;
  const PAD = 8;
  const scale = Math.min((SIZE - PAD * 2) / (dims.widthM || 1), (SIZE - PAD * 2) / (dims.depthM || 1));
  const px = (x: number) => PAD + x * scale;
  const py = (y: number) => PAD + y * scale;

  return (
    <div className="aspect-square w-full rounded-md border border-border bg-muted/40 overflow-hidden flex items-center justify-center">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-[85%] h-[85%]">
        {walls.map((w, i) => (
          <polyline
            key={i}
            points={w.points.map(([x, y]) => `${px(x)},${py(y)}`).join(" ")}
            fill="none"
            stroke={WALL_COLOR[w.kind]}
            strokeWidth={w.kind === "wall" ? 2.5 : 1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </div>
  );
}
