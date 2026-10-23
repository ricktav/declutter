# HomeBase contract: homebase-3d companion

HomeBase stays the SSOT. [homebase-3d](https://github.com/ricktav/homebase-3d) only talks through tRPC. These additions are additive; existing callers keep working.

## `items.listAll` cover metadata

Each row gained (optional for old clients):

| Field | Type | Meaning |
| --- | --- | --- |
| `imageKey` | `string \| null` | unchanged: cover storage key |
| `imageIsCutout` | `boolean` | cover has a `cropBox` (newest cutout). `false` when there is no cover, or the cover is a whole Photo / whole-scene pin |
| `imageWidth` | `number \| null` | cover pixel width after EXIF orientation |
| `imageHeight` | `number \| null` | cover pixel height after EXIF orientation |

Dimensions come from `photos.width` / `photos.height` (set on upload, cutout, recrop). Existing files stay null until `scripts/backfill-photo-sizes.mjs --apply`.

## Per-Thing 3D model (`items.listAll` / `items.get` / `items.setModel3d`)

HomeBase stores the choice; homebase-3d writes the file URL later. Never delete a Thing to clear a model.

| Field | Type | Meaning |
| --- | --- | --- |
| `model3dRoute` | `'auto' \| 'none' \| 'agent' \| 'meshy' \| 'capture'` | stored choice; default `auto` |
| `model3dUrl` | `string \| null` | `/uploads/…`, `local/…`, or an http(s) URL to a `.glb` / `.usdz` / `.js` module |
| `effectiveModel3dRoute` | `'none' \| 'agent' \| 'meshy' \| 'capture'` | computed: `auto` → `capture` when `attributes.favourite` / `favorite` is `yes`/`true`/`1`, else `meshy` |

```
items.setModel3d({
  id?: number,
  ids?: number[],          // at most 200 unique; id and ids may be combined
  route?: Model3dRoute,
  url?: string | null      // omit to leave; null / "" clears
})
→ { ok: true, count: number }   // missing ids are skipped, not an error
```

`agent` is procedural Three.js code (3d-model-anything style). `capture` is Apple Object Capture. `meshy` is image-to-3D GLB.

## `photos.urls`

Batch of `photos.url`. Query.

```
{ ids?: number[], keys?: string[] }   // at least one list; at most 200 entries combined
→ { id: number | null, key: string, url: string | null, width: number | null, height: number | null }[]
```

- `ids` are photo ids (unknown ids omitted).
- `keys` are storage keys (`local/…`, same as `photos.url` / `imageKey`). A key with no photo row still gets a `url`; `id` / dimensions are then null.
- `url` is the same-origin `/uploads/…` path, or null if the file is gone.

## `rooms.linkScan` / `rooms.linkedScans`

Pointer only. **Not** `rooms.upsertFromScan` and **not** `rooms.scans` (those import geometry and merge Things).

```
rooms.linkScan({
  roomId: number,
  source: string,          // companion app, max 64, e.g. "homebase-3d"
  externalId: string,      // that app's scan id, max 255
  capturedAt?: Date,       // optional
  metadata?: Record<string, string | number | boolean | null>
})
→ { id, roomId, source, externalId, capturedAt, metadata, createdAt, created: boolean }
```

The same `(source, externalId)` re-linked to another room is moved. Never creates, moves or deletes Things or photos. Rows stay when the room is removed.

```
rooms.linkedScans({ roomId }) → { id, roomId, source, externalId, capturedAt, metadata, createdAt }[]
```

Newest first.

## `inbox.importGeojson` and `homebase-scan/1`

`parseGeojsonFloor` (`api/lib/geojsonFloor.ts`) accepts the enriched FeatureCollection from homebase-3d when `properties.format` (or top-level `format`) is `homebase-scan/1`, or when any feature has `properties.featureType`. Coordinates are room-frame metres (shifted so min x/y is the origin).

| `featureType` | Geometry | Plan |
| --- | --- | --- |
| `room` | Polygon | floor outline → `widthM` / `depthM` (not furniture) |
| `wall` | LineString | `walls[]` kind `wall` |
| `opening` | LineString | `walls[]` kind `door` or `window` from `properties.kind` (not a wall) |
| `object` | Polygon | furniture (`kind` / `category`, optional `wM` `dM` `hM` `rotDeg`) |
| `photo` | Point | ignored for the plan (returned as `photos` for later) |

A file with no `featureType` (old MappedIn lon/lat export) is unchanged: every LineString is a wall/door/window, every Polygon is furniture.

## Migration

`0014_photo-size-scan-links`: nullable `photos.width` / `photos.height`; new table `room_scan_links`. Additive only.

`0015_model3d`: `items.model3dRoute` (`varchar(16)` NOT NULL DEFAULT `'auto'`), `items.model3dUrl` (`varchar(512)` nullable), `items.model3dUpdatedAt` (nullable timestamp). Additive only. Existing rows become `auto` / null / null.

Live MySQL (`10.50.0.10` / `declutter`) dry-run — **do not apply from this PR**:

```
SHOW COLUMNS FROM items LIKE 'model3d%';
-- expected: empty before apply
-- then the three ALTERs in db/migrations/0015_model3d.sql
-- InnoDB instant DDL: ADD COLUMN with a constant default, plus two nullables.
```

## Backfill

```
node scripts/backfill-photo-sizes.mjs                 # dry run on DATABASE_URL
node scripts/backfill-photo-sizes.mjs --apply         # write sizes
node scripts/backfill-photo-sizes.mjs --url <mysql> [--apply]
```

Writes only `photos.width` / `photos.height`. Never deletes. Missing or unreadable files are counted and skipped.
