# HomeBase contract: biggest folders on a volume

Give this to a service that already knows **which directories are large** on a host (file-scanner / `file_inventory.db` / `dir_rollup`, Data Tracker, a custom `du`). HomeBase’s Storage page shows those folders when you click a volume.

Do **not** write the declutter MySQL tables yourself. Do **not** send guessed `df` numbers through `storage.report` — that overwrites capacity and use. Folders go through **`storage.reportDirs`**.

HomeBase already has the disks and volumes (Mini local collector + Data Tracker import). This call only fills `storage_dirs`.

## Where

Production API (Mac mini M4):

```
POST http://127.0.0.1:3001/api/trpc/storage.reportDirs
```

From another host on the LAN, use the Mini’s IP (`http://10.50.0.102:3001` unless Settings say otherwise).

Auth, when `APP_TOKEN` is set:

```
Authorization: Bearer <APP_TOKEN>
```

JSON envelope (tRPC). Numbers and strings only — no `Date` objects.

## Resolve the machine

One of:

- `itemId` — HomeBase Thing id of the **computer or NAS** (role `laptop` | `desktop` | `server` | `sbc` | `nas`), or of a disk on that machine.
- `host` — hostname, IP, or `machine.id`. Not the display name. `.local` is stripped. `macmini-m4.local` matches `hostname: macmini-m4`.

Lookup without a hardcoded id:

```
GET /api/trpc/items.listAll?input={"json":{"houseId":null}}
```

Match `attributes.hostname`, `ip`, `machine.id`, `aliases`, `host_alias`. Starred machines have `attributes["storage.starred"] === "yes"`.

If `host` matches two machines the call is refused (`BAD_REQUEST`).

## Collecting mounts from `storage.overview`

Call with **`houseId: null`** (all houses). Do **not** read `computers[].volumes` — after Machine → Disks that array is only leftover inferred mounts (often empty, or just something like OptiPlex `/media/rick/Extern`). Real filesystems sit on the disks under the machine.

For computer `c` the mount list is:

```
[...c.drives, ...c.attached, ...(c.inferredDisks ?? []), ...(c.unlinkedDisks ?? []), ...(c.remoteMounts ?? [])]
  .flatMap((d) => d.volumes)
```

Use each volume’s `mountPoint` (and optional `label` / `device`). Skip `measure: "remote"` if you only scanned local disks. `dirCount` is how many folders HomeBase already has.

A Storage card that shows disk bars already has volumes, even when `c.volumes` is `[]`.

## Body

```json
{
  "json": {
    "host": "optiplex-990",
    "source": "file-inventory",
    "volumes": [
      {
        "mountPoint": "/",
        "dirs": [
          { "path": "/home", "bytes": 2772201472 },
          { "path": "/usr", "bytes": 4966809600 }
        ]
      }
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `source` | 1–32 chars. Use `file-inventory` for the scanner. |
| `volumes` | 1–64. Each is one **already-known** filesystem. |
| `mountPoint` | Volume root as HomeBase has it (`/`, `/Volumes/T7`, `/volume1`, `/media/rick/Elements`). 1–255 chars. Trailing slash dropped except `/`. |
| `dirs` | 0–100. Empty list **clears** folders for that volume. |
| `dirs[].path` | Absolute path, 1–512 chars. Immediate children of the mount are what the Storage panel expects (`/Users`, `/volume1/homes`). Deeper paths are stored as-is. |
| `dirs[].bytes` | Integer ≥ 0. Same path twice: the larger byte count wins. |
| `label` / `device` | Optional. Only needed when the mount string might not match (label vs path). |

On a Mac, if both `/` and `/System/Volumes/Data` exist, put user folders on **Data** (`mountPoint`: `/System/Volumes/Data`, paths like `/Users`), not on `/`. `du` from `/` follows firmlinks and double-counts.

## What it does

- Replaces that volume’s folder list wholesale.
- Leaves capacity, used, data role, kernel `device`, and the volume’s `measuredAt` (last `df`) alone.
- Does **not** create volumes. Unknown `mountPoint` → `{ mountPoint, reason: "no matching volume" }` in `skipped`; other volumes still write.
- Archived or non-storage Things → `BAD_REQUEST`.
- Item missing / unknown `host` → `BAD_REQUEST`.

Success:

```json
{
  "result": {
    "data": {
      "json": {
        "itemId": 203,
        "itemName": "OptiPlex 990",
        "volumes": 1,
        "dirs": 2,
        "skipped": []
      }
    }
  }
}
```

## curl

```bash
curl -sS -X POST "$HOMEBASE_BASE/api/trpc/storage.reportDirs" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $APP_TOKEN" \
  -d '{"json":{"host":"optiplex-990","source":"file-inventory","volumes":[{"mountPoint":"/","dirs":[{"path":"/home","bytes":2772201472},{"path":"/usr","bytes":4966809600}]}]}}'
```

Omit the `authorization` header when the server has no `APP_TOKEN`.

## Mapping from file-scanner (`dir_rollup`)

1. Group rollup rows by host, then by volume prefix (longest matching `df` mount, or the flattened overview mounts above).
2. Keep **immediate children of the mount** (one path component more than the mount). Rank by size, take at most 100.
3. POST one `storage.reportDirs` per host (`source: "file-inventory"`).
4. Skip mounts HomeBase does not have; read `skipped` instead of inventing a volume.

Disk rows (`df`) are filled by Data Tracker `homebase-sync.js` on prodesk-rt1 (~60 s after sources, `storage.enabled` in `homebase-map.json`; Mini is `skip_hosts`) and by Mini `storage-report-local.mjs` for item 51. `scripts/storage-import-data-tracker.mjs` is the same import, run by hand. Folders wait until those mounts exist.

## Do not use for this

| Call | Why not |
| --- | --- |
| `storage.report` with `dirs` | Also writes capacity/use. Only for a collector that ran `df` on that host (Mini local script, SSH probe). |
| `storage.importSources` | Data Tracker disks/filesystems. It **omits** `dirs` on purpose. |
| Direct `INSERT` into `storage_dirs` | Bypasses matching, events, and the volume row. |

## Read-back

```
GET /api/trpc/storage.dirs?input={"json":{"volumeId":<id>}}
GET /api/trpc/storage.overview?input={"json":{"houseId":null}}
```

Overview rows carry `dirCount`. Click a volume on `/storage` to see the list.
