# Rules for agents in this repo

Read this before you change code. These rules apply to every agent (Kimi, Claude sessions, others) and to Rick's own scripts. Rick decides when a rule changes.

## 1. Who owns what

| Area | Files | Owner |
| --- | --- | --- |
| Flow front end | `flow/`, `src/flow/` | Claude session "declutter-flow" |
| Workbench front end | `index.html`, `src/pages/`, `src/components/`, `src/context/` | Rick, or the session Rick assigns |
| API and database | `api/`, `db/` | Shared: follow sections 2, 3 and 4 |

- Do not edit `flow/` or `src/flow/`. If your change needs a Flow change, stop and tell Rick.
- If `npm run check` shows errors only under `src/flow/`, your change broke a Flow contract. Do not fix Flow yourself. Tell Rick.
- Do not commit files that another session made (for example its plans in `docs/`).
- On 2026-10-03 one session (finalize plan) worked on every area; the ownership above applies again to new work.

## 2. Contracts that Flow uses

Do not remove or rename these. Do not change their inputs or outputs in a way that breaks a caller. You can add optional fields.

- tRPC: `ping`, `inbox.list`, `inbox.create`, `inbox.triage`, `inbox.acceptMany`, `inbox.dismiss`, `items.listAll`, `items.get`, `items.create` (`roomId`, `houseId`), `items.update`, `items.setVerification`, `items.setArchived`, `items.setDecision`, `items.patchAttributes`, `items.addRelation`, `items.removeRelation`, `items.listRelations`, `houses.list`, `areas.list`, `rooms.list`, `rooms.ensure`, `attachments.url` (deprecated alias of `photos.url`), `rooms.get`.
- Photos (since the photos consolidation): `photos.url`, `photos.get`, `photos.listAll`, `photos.listForItem`, `photos.add`, `photos.remove`, `photos.unlink`, `photos.ensureForCapture`, `photos.createCutout`, `photos.recrop`, `photos.forRoom`, `pins.*` (all procedures: listForPhoto, listForItem, add, update, resolve, remove, detect, suggestForBox), `itemLinks.add`, `itemLinks.remove`, `itemLinks.listForItem`. Deprecated aliases, kept for one release. Their inputs are unchanged except that `attachments.add` with `kind: "image"` now needs a `storageKey` (BAD_REQUEST otherwise); their outputs only gained fields (`listAllImages` rows carry `areaName`, `isItemCover` and `title`): `attachments.url`, `attachments.add`, `attachments.remove`, `attachments.unlink`, `attachments.listAllImages`, `attachments.listForItem`. They return `item_links` rows with a negated id, and `items.get` still carries a deprecated `attachments` array in the same shape next to `photos` and `links`; pass ids back to `attachments.remove` unchanged; `attachments.unlink` accepts photo ids only. New callers use the `photos.*` and `itemLinks.*` names.
- HTTP: `POST /api/upload` (multipart, fields `file` and `scope`).
- Shared code: `src/providers/trpc.tsx`, `src/components/AuthGate.tsx`, `src/components/ItemRoomPreview.tsx`, `src/components/GeojsonThumb.tsx`, `src/components/RoomPicker.tsx` (`DEFAULT_FLOORS` only), `src/components/HouseSwitcher.tsx`, `src/context/house.tsx` (`useHouse`, `HOUSE_STORAGE_KEY`), `src/lib/upload.ts`, `src/lib/lastRoom.ts`, `src/hooks/use-last-room.ts`, `src/lib/auth.ts`.
- Computer Lab adapter client (`/Volumes/T7/computer-lab-ssot`, `server-ssot.js`): tRPC `items.listAll` (with `houseId: null`), `items.get`, `items.create`, `items.update`, `items.setArchived`, `items.setDecision`, `items.setParent`, `items.addRelation`, `items.removeRelation`, `items.patchAttributes`, `items.listRelations`, `rooms.list` (with `houseId: null`), `rooms.ensure`, `photos.listAll` (falls back to `attachments.listAllImages`), `photos.add`, `photos.unlink`, `photos.listForItem`, `inbox.list`, `inbox.create`, `inbox.triage`, `inbox.acceptMany`, `inbox.dismiss`, `areas.list`, `houses.list`, `ping`; HTTP `POST /api/upload`, `GET /uploads/:name`; header `x-house-id` when `HOMEBASE_HOUSE_ID` is set.
- iOS app client (`ios/`): tRPC `ping`, `inbox.list`, `inbox.create`, `inbox.triage`, `inbox.acceptMany` (`roomId`; `itemId` sent as null for a new Thing), `inbox.dismiss`, `items.listAll`, `items.update` (`roomId`), `items.setVerification`, `items.setArchived`, `items.setDecision`, `items.patchAttributes`, `houses.list`, `areas.list`, `rooms.list` (with `houseId: null`), `rooms.ensure`, `rooms.get`, `photos.url`; HTTP `POST /api/upload`; header `x-house-id` from its Settings.
- Home Inventory Twin view (lidarventory, :8001, read-only): tRPC `items.listAll`, `rooms.list`, `rooms.get`, `photos.listAll`, `photos.forRoom`, `pins.listForItem`.
- Data Tracker sync (prodesk-rt1, `~/clawd/data-tracker`, `homebase-sync.js` + `homebase-map.json`; runs about 60 s after new sources arrive, or on `POST /api/homebase-sync`, `?dry=1` for a plan; `HOMEBASE_SYNC=off` disables it): tRPC `items.listAll`, `items.listRelations` (`type: backs-up`), `items.addRelation` (`backs-up` only, never removes), `items.patchAttributes` (only `backup.<storedOnId>.last_at`, `.current`, `.notes`; notes only when empty). The item ids it maps are fixed in `homebase-map.json`; do not rename those keys or remove these procedures.
- Storage collectors (`scripts/storage-report-local.mjs` for the machine it runs on; the Data Tracker for the others): tRPC `storage.report({ itemId, source, volumes: [{ mountPoint, label?, fsType?, device?, container?, capacityBytes, usedBytes, dirs?: [{ path, bytes }] }] })`, bytes, at most 64 volumes and 100 directories per volume, only for an item whose `role` is `laptop`, `desktop`, `server`, `sbc`, `nas` or `storage`. A report never changes a volume's `dataRole` and never deletes a volume; `container` (at most 64, e.g. the APFS container `disk3`) groups volumes that share one container's capacity: they must report the same `capacityBytes`, their summed `usedBytes` must fit in it, and the device counts that capacity once per container; null or absent = the volume is its own container (old payloads keep working). It keeps the device's `storage_gb` equal to the sum of its container capacities and `storage_free_gb` to that minus every volume's use. The whole report is refused with BAD_REQUEST when any volume has used above capacity, the item is archived, or a length limit is exceeded: mountPoint 255, label 128, device 128, path 512, source 32. For the Data Tracker: one volume per filesystem: drop bind/overlay duplicates of the same device or the device's storage_gb double-counts; at most 64 volumes per report. Reads: `storage.overview` (totals count only volumes of active items: used bytes per data role, plus one `freeBytes` and `capacityBytes` figure; capacity belongs to no role; computers carry `attached`, devices `attachedRelationId` and `backsUp`), `storage.dirs`; writes: the role is set with `storage.setRole({ volumeId, dataRole })`, one of `unique`, `test`, `backup`, `archive`, `system`, `media`, `scratch` or `null`; `storage.removeVolume({ volumeId })` deletes a volume and its directories and recomputes `storage_gb`/`storage_free_gb` from the remaining volumes (with none left the keys stay). `storage_gb`/`storage_free_gb` are decimal GB (bytes / 1e9), so a hand-entered GiB value moves once at the first report.
- Location:
  - A place is a room: Flow's `Place = { roomId }`. Items, captures and photos locate by `roomId`; the room carries its house and floor.
  - The `x-house-id` header is the session house. Without the header (null), lists cover all houses; `rooms.ensure` and `rooms.create` require a house.
  - `items.update`, `items.create`, `inbox.acceptMany` and `inbox.fileObject` take `roomId` (and `houseId` for an unplaced item); the old `floor`/`room` inputs are ignored by validation, not rejected.
  - `items.update` with `houseId` and no `roomId` moves an item, unplaced, into another house; for its own house it changes nothing.
- Data meaning:
  - `items.decision` is `keep`, `sell`, `donate`, `toss` or `later`. `items.decidedAt` is the time of the decision.
  - "Gone" is `items.status = "archived"` on an item with a decision. Do not add a second status for this.
  - `items.verificationStatus` is `detected`, `confirmed` or `rejected`. Flow never shows `rejected` items.
  - `items.attributes` has two kinds of keys. Plain keys describe the thing: `role`, `brand`, `model`, `serial`, `os`, `cpu`, `ram_gb`, `storage_gb`, `hostname`, `ip`, `mac`. Prefixed keys hold workflow state: `sell.ask_price`, `sell.channel`, `sell.listed_at`, `sell.sold_price`, `sell.sold_at`, `donate.to`, `lab.exclude`, `lab.backup`, `lab.data_copied_at`, `lab.wiped_at`. Do not rename these keys. Dates are `YYYY-MM-DD`; prices are whole euros.
  - A relation of type `backs-up` means `fromItemId` (a NAS, drive or server) holds the backup of `toItemId` (the device).
  - A relation of type `attached-to` means `fromItemId` (an external drive or NAS) is plugged into or mounted on `toItemId` (a computer); the Storage page groups it under that computer. It does not make the drive internal.
  - The Computer Lab adds these keys. Plain: `drive_type` (`hdd`, `ssd`, `nvme`, `sd`, `usb`, `emmc`), `storage_free_gb`, `mount_point`. Workflow: `lab.ref` (the old lab app's id or ids, comma-separated; marks an imported item), `lab.status` (`Inactive`, `Storage`, `Broken`), `lab.notes`, `lab.category`, `lab.merged_into`, and `backup.<targetItemId>.last_at` / `.verified_at` / `.current` / `.notes` on the backed-up device. Energy, written by the Data Tracker sync from Plugwise: `energy.kwh_2025` (measured kWh, one decimal), `energy.avg_w_2025` (average watts over the measured hours), `energy.days_2025` (days with data), `energy.meter` (`plugwise:<circle MAC>`); the year is part of the key, so a later year adds keys and never overwrites. Do not rename them.
  - An internal drive is an item with role `storage` whose `parentId` is its computer. It needs no backup of its own while it sits in the computer.

NOTE: The rooms consolidation landed on `main` on 2026-10-02; `items.floor`/`items.room`, `attachments.houseId`/`floor`/`room` and `houses.floors` no longer exist.

## 3. Database

- Live database: MySQL on `10.50.0.10`, database `declutter` (`DATABASE_URL`).
- Test database: `declutter_test` (`TEST_DATABASE_URL`). It is disposable. The tests in `api/test/` truncate it.
- Change the schema only in `db/schema.ts`. Then run `npm run db:generate -- --name <short-name>`. Read the generated SQL. Commit the SQL, the snapshot and `meta/_journal.json`.
- Make one schema change branch at a time. Two branches must not use the same migration number.
- Additive changes (new table, new nullable column, new index): apply to the test database, then to the live database. Then tell Rick.
- Destructive changes (drop, rename, type change, backfill): ask Rick first. Make a backup first.
- Do not change the live database by hand. Do not point tests or experiments at `DATABASE_URL`.

CAUTION: Both databases use the same `uploads/` folder. Delete code removes a file when no row in the *current* database uses it. Do not copy live rows into `declutter_test`, or a test delete can remove a live photo.

## 4. Git

- Run `git fetch` before you start.
- Work in your own worktree: `git worktree add ../declutter-<topic> -b <topic> origin/main`. Do not switch branches in a folder that another session uses.
- Use one topic for each branch.
- Before you push:
  1. Run `npm run check`. It must pass. Both front ends share the API types.
  2. Run `npm test` when you change database code.
  3. Run `npm run build` when you change the build or the server.
- Merge to `main` only when Rick says so. Use a fast-forward or a rebase. Do not force-push to `main`.
- Write in the commit message why you made the change, not only what you changed.

## 5. Product words

- Use five words on every screen: Thing, Place, Photo, Decision, Lens.
- The Flow loop is "register all, act later": Snap, then Sort (what is it, is it right, where is it), then Act (keep, sell, donate, toss, later), then Gone.
- A lens adds its own fields, views and steps for one field of work (first lens: Computer lab). A lens does not copy core data and does not use a second database.
- Live meter data (DSMR, Home Assistant, Zigbee) is read-only. It does not go through the confirm step.

## 6. Run the app

- `npm run dev` starts the Workbench at `/` and Flow at `/flow/` on port 3000. Production runs `node dist/boot.js` on port 3001 from `/Volumes/T7/declutter`.
- Run one dev server for each worktree, on another port and against the test database: `DATABASE_URL="$TEST_URL" npx vite --port 3002`. `node scripts/seed-test-db.mjs` fills the test database with a two-house sample.
