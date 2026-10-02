export type GeojsonWall = { points: [number, number][]; kind: "wall" | "door" | "window" };

/** A capture's `kind` is "scan" only when it came in through the Telegram
 * bot's extension-sniffing; the web inbox upload path tags everything
 * non-image as generic "file" regardless of extension - so also recognize
 * a geojson by its stored filename, or a thumbnail never renders for one
 * uploaded through the web form. */
export function isGeojsonFile(storageKey: string | null | undefined): boolean {
  return !!storageKey && /\.(geo)?json$/i.test(storageKey);
}

/**
 * Project a MappedIn-style GeoJSON floor export's lon/lat-shaped local
 * coordinates into meters, same equirectangular approximation used by
 * scripts/import-geojson-floor.mjs - kept in sync so the Inbox preview
 * shows the same shape the room will actually get once imported.
 */
export function projectGeojsonFloor(geojson: {
  features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[];
}): { walls: GeojsonWall[]; widthM: number; depthM: number } | null {
  const allCoords: [number, number][] = [];
  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") allCoords.push(...(f.geometry.coordinates as [number, number][]));
    if (f.geometry.type === "Polygon")
      for (const ring of f.geometry.coordinates as [number, number][][]) allCoords.push(...ring);
  }
  if (allCoords.length === 0) return null;

  const lon0 = Math.min(...allCoords.map((c) => c[0]));
  const latMax = Math.max(...allCoords.map((c) => c[1]));
  const metersPerLat = 111320;
  const metersPerLon = 111320 * Math.cos((latMax * Math.PI) / 180);
  const project = ([lon, lat]: [number, number]): [number, number] => [
    (lon - lon0) * metersPerLon,
    (latMax - lat) * metersPerLat,
  ];

  const walls: GeojsonWall[] = [];
  for (const f of geojson.features) {
    if (f.geometry.type !== "LineString") continue;
    const kindRaw = f.properties.kind;
    const kind = kindRaw === "Door" ? "door" : kindRaw === "Window" ? "window" : "wall";
    walls.push({ points: (f.geometry.coordinates as [number, number][]).map(project), kind });
  }
  if (walls.length === 0) return null;

  const wallPoints = walls.flatMap((w) => w.points);
  const widthM = Math.max(...wallPoints.map((p) => p[0]));
  const depthM = Math.max(...wallPoints.map((p) => p[1]));
  return { walls, widthM, depthM };
}
