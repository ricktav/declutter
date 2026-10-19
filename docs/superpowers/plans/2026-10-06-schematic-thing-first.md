# Schematic Room View and Thing-First Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** In Annotate, pin a known Thing with two taps (the Thing, then the spot). On the room page, a Schema view per room: next to each Photo a clean schematic where every pinned Thing with a frame is a labelled block, filtered by Type (a small tree in a new plain attribute `kind`), Tags, Category, focus and decision, with a details modal. A backfill classifies existing Things by an evidence ladder, dry-run first.

**Adjustments of 2026-10-19 (main d931e4f):** the Map page no longer exists, the Schema view lives on the room page's photo column (`src/pages/RoomPlan.tsx`, `RoomPhotoPool`); the Type key is `attributes.type` (not `kind`: Systems already uses `kind` for a service runtime); the classifier builds on the Systems view's machine rule (`src/lib/systemsAttrs.ts`: `MACHINE_ROLES`, `PERIPHERAL_ROLES`, `NETWORK_ROLES`, `SKIP_ROLES`, `isMachineItem`), moved to a shared module so there is one definition of "computer"; the UI keeps the word Topic for areas, and the flagged filter is called "Flagged" (Focus means the Focus page now); pins with `status = "dismissed"` are skipped by queries and restored by Thing-first pinning instead of duplicated; `items.search` is house-scoped now, so "Search all Things" passes `houseId: null`; `items.queue` and the three UI depths exist, do not touch them.

**Architecture:** One additive query `pins.listForRoom({ roomId })` joins pins with their item's role, decision, verification and area colour for every Photo of the room and its rolled-up child rooms. Annotate gains a "Place a Thing" mode that lists the room's Things and turns a tap on the Photo into `pins.add` or `pins.update`. The Map page gains a Photos | Schema switch; the schematic is a pure component (`PhotoSchematic`) fed by pins and a filter state, reused on the item page.

**Spec:** docs/superpowers/specs/2026-10-06-schematic-view-and-thing-first-pinning-design.md (homelab-map session, Rick's decisions of 2026-10-06 included). Reference, not to copy: github ricktav/homelab-map `overzicht.html`, `app.html`.

## Global Constraints

- No schema change. Additive API only; `pins.*`, `photos.*`, `rooms.*`, `items.*` keep inputs and outputs. Workbench only: `src/pages/`, `src/components/`; nothing under `flow/`, `src/flow/`, `ios/`, `db/`.
- Worktree `/Volumes/T7/declutter-schema`, branch `schematic-view`, from `main`. Shared test DB: wait until no `node … vitest` process runs. Baselines: eslint 30, tests 256+.
- Rick's decisions: "Place a Thing" on by default when the Photo has a room; presets are Type-tree nodes ("Computers", "Computers & displays & storage"), one constant, easy to change; a NAS is a Computer; frame editing by drag handles; schematic also on the item page.
- Taxonomy (Part C): new plain attribute keys `type` (the most specific Type; ancestors derived from the tree, never stored) and `tags` (comma-separated, lower case; `brand` is treated as a tag too). `role` untouched. Add both keys to AGENTS.md §2 Data meaning. Backfill writes only through `items.patchAttributes`, dry-run by default, test DB first, Rick approves the table before live.

## Review Focus

1. A Thing already pinned on this Photo: tapping again moves the pin and keeps its frame size; never a second pin for the same Thing on the same Photo. Test in Task 2 (click-through) and the existing `ensurePinForCutout` one-per-photo rule is not weakened.
2. `pins.listForRoom` on a room with child rooms returns the child rooms' Photos' pins too, and never pins of other rooms; `houseId: null` works. Test in Task 1.
3. Schematic aspect ratio equals the Photo's; a block's left/top are centre minus half size; blocks without a frame are hidden unless "show points". Click-through in Task 3.
4. Filters are client-side and remembered (URL query + localStorage); the "Computers & storage" preset hides a keyboard pin. Click-through in Task 3.
5. Archived or rejected Things are neither listed in "Place a Thing" nor drawn as blocks. Test in Task 1 (query excludes them) and Task 2 (list).
6. Evidence ladder: a `meter` named "Plugwise – Pi" is never a computer; "laptop power adapter" without ip/hostname/mac is never a computer; a Thing with an ip and no role is a computer; a NAS is under computer. Test in Task 0.
7. Filter semantics: Type = subtree (choosing "computer" includes imac, mac-mini, raspberry-pi, nas in any Topic); Tags OR within the facet; AND across facets; a Thing without `kind` derives its type from `role`. Test in Task 0 (pure) and click-through in Task 3.

---

### Task 0: Taxonomy module (shared, pure)

**Files:** `db/taxonomy.ts` (new; no imports beyond types, so both the API and the Workbench can import it: `@db/taxonomy`); move the role sets and `isMachineItem` logic out of `src/lib/systemsAttrs.ts` into it and have `systemsAttrs.ts` re-export them (so Systems, AreaView, ItemDetail and the graph keep working unchanged); `api/test/taxonomy.test.ts` (pure, no DB); `AGENTS.md` §2 Data meaning (`type`, `tags`).

**Interfaces produced:**
```ts
export const TYPE_TREE: Record<string, string | null>; // child → parent; roots have null:
// computer: null; desktop: "computer"; imac: "desktop"; "mac-mini": "desktop"; tower: "desktop"; laptop: "computer"; macbook: "laptop"; server: "computer"; sbc: "computer"; "raspberry-pi": "sbc"; nas: "computer";
// display: null; monitor: "display"; projector: "display"; tv: "display"; input: null; keyboard: "input"; mouse: "input"; storage: null; drive: "storage"; network: null; switch: "network"; "patch-panel": "network"; meter: null; phone: null
export const TYPE_LABELS: Record<string, string>; // "mac-mini" → "Mac mini", "raspberry-pi" → "Raspberry Pi", …
export function ancestorsOf(type: string): string[];           // imac → ["desktop", "computer"]
export function isUnder(type: string | null, node: string): boolean; // subtree test incl. itself
export function derivedType(attrs: Record<string, unknown>): string | null; // attrs.type, else from attrs.role (desktop/laptop/server/sbc/nas/monitor/keyboard/mouse/storage/switch/meter/phone → same or mapped), else null
export function tagsOf(attrs: Record<string, unknown>): string[]; // attrs.tags split + brand lower-cased, de-duplicated
export const SCHEMA_PRESETS: Array<{ id: string; label: string; types: string[] }>; // computers: ["computer"]; computers-displays-storage: ["computer", "display", "storage"]
export type ComputerVerdict = { verdict: "computer" | "suggested" | "no"; rule: "role" | "machine-signal" | "name" | "veto" | "accessory" | "none"; type?: string; tags?: string[] };
export function judgeComputer(item: { name: string; attributes: Record<string, unknown> }): ComputerVerdict;
```
`judgeComputer` implements the ladder on top of `isMachineItem`'s evidence: (1) role in MACHINE_ROLES (desktop, laptop, server, sbc, nas) → computer with type = role (and a more specific kind from the name when unambiguous: imac, mac-mini, macbook, raspberry-pi; tags apple / raspberry-pi / hp / dell from name or brand); (2) any MACHINE_SIGNAL_KEYS evidence (ip, hostname, mac, os, cpu, ram_gb, storage_gb or a storage volume, as `isMachineItem` already counts) and role not in PERIPHERAL_ROLES ∪ NETWORK_ROLES ∪ SKIP_ROLES → computer, type from name or "computer"; (3) name/model matches imac|mac mini|macbook|raspberry|\bpi\b|volumio|laptop|desktop|server|nas with no accessory word (adapter, stand, charger, chassis, panel, sleeve, pouch, case, cable, power, brick, dock, mouse, keyboard, monitor, drive, ssd, hdd, nvme, ram) → suggested; an explicit non-computer role vetoes 3 ("veto"); accessory word → "accessory"; else "none".

Tests: ancestors of imac; nas under computer; derivedType from role; tagsOf with brand; the four ladder cases from Review Focus 6 plus a "Volumio PI" without role → suggested; presets resolve to subtrees.

Commit: "Taxonomy: a Type tree in attributes.type, tags, and the evidence ladder for 'is a computer'".

### Task 1: API — `pins.listForRoom`

**Files:** `api/routers/pins.ts` (new procedure), `api/lib/pins.ts` or inline (shared join with `listForPhoto`), `api/test/pins-room.test.ts`, `AGENTS.md` §2 (one line under the Workbench-facing procedures).

**Interface:** `pins.listForRoom({ roomId: number })` → `Array<{ photoId, photoTitle, photoStorageKey, ...pin (id, xPct, yPct, wPct, hPct, label, itemId, status, flagged, origin), itemName, itemAreaColor, item: { id, name, role, kind, tags: string[], decision, verificationStatus, status, areaId, attributes: { hostname?, ip?, os?, ram_gb?, storage_gb?, cpu?, brand? } } | null }>` (`type` = `derivedType(attributes)`, `tags` = `tagsOf(attributes)`)`, for every Photo whose `roomId` is the room or one of its rolled-up child rooms (same room set `rooms.get` uses, `collectDescendantItems` in api/routers/rooms.ts), pins with `status != "dismissed"`, of active, non-rejected Things only (item-less pins included with `item: null`). Ordered by photoId, then pin id.

Tests: room with two Photos and a child room's Photo → all pins, none from another room; a dismissed pin excluded; archived Thing's pin excluded; role/decision/area colour present; empty room → `[]`; `houseId: null` caller works.

Commit: "pins.listForRoom: a room's pins with their Things' role, decision and area, in one call".

### Task 2: Annotate — "Place a Thing" mode

**Files:** `src/pages/Annotate.tsx`, `src/components/PlaceThingPanel.tsx` (new).

- Side panel mode switch "Place a Thing | Draw a frame" (existing flow); default "Place a Thing" when the Photo has a room, else the old flow with only the search fallback.
- `PlaceThingPanel`: search box; rows for the room's Things (`rooms.get` items incl. rolled-up; active, not rejected): name, role chip, state "pinned here" (from `pins.listForPhoto`), "pinned elsewhere" (from `pins.listForItem`, fetched lazily per visible row or one batched call if available), "not pinned"; sort not-pinned first; star toggles `pins.update({ id, flagged })` on this Photo's pin (disabled without one); "Search all Things" opens the existing `ItemPicker`.
- Selected row + tap on the Photo: not pinned here → `pins.add({ photoId, xPct, yPct, wPct: 20, hPct: 20, itemId, label: name })` (pins.add always writes origin user / status confirmed; check its zod for wPct/hPct); pinned here (incl. a `dismissed` pin of this Thing on this Photo) → `pins.update({ id, xPct, yPct, status: "confirmed" })` keeping wPct/hPct, so a Thing never has two pins on one Photo. After placing, selection moves to the next not-pinned row; Esc or tapping the selected row clears.
- Frame editing: the existing corner drag handles apply to the selected pin's frame (reuse the existing per-pin resize code; make sure it works for confirmed pins, not only suggestions).
- Existing warnings ("make sure it is the same object" for a Thing confirmed elsewhere) stay.

Gates: check, eslint ≤ 30, build. Click-through on the test DB (seed; dev server port ≥ 3018): pin three Things with two taps each; second tap on a pinned Thing moves it and keeps size; star toggles focus; a Photo without a room shows only the fallback.

Commit: "Annotate: Place a Thing — pick the Thing, tap the Photo".

### Task 3: Room page — Schema view, filters, modal

**Files:** `src/pages/RoomPlan.tsx` and the photo column component (`RoomPhotoPool` / `RoomPhotoCard`; read them first), `src/components/PhotoSchematic.tsx` (new, pure: props `pins`, `aspect`, `filter`, `showPoints`, `onPick`), `src/components/SchemaFilters.tsx` (new), `src/components/ThingModal.tsx` (new, existing Dialog), `src/lib/schemaFilter.ts` (filter state, presets constant `SCHEMA_PRESETS`, URL/localStorage sync).

- On the room page's photo column a switch "Photos | Schema". Schema: one card per Photo of the room from `pins.listForRoom` grouped by photoId: the Photo (left) and the schematic (right) with the Photo's aspect ratio (from the loaded image's natural size, cached per storageKey as the Flow FramedPhoto does); blocks: fill = area colour at low alpha, border = area colour, name + role label, flagged → accent ring, suggested → dashed; "show points" toggle draws unframed pins as small dashed markers.
- Filters bar: **Type** as a tree picker (collapsible nodes from `TYPE_TREE`; choosing a node selects its subtree; "Other" for Things with no kind), **Tags** chips (values from the data), **Topic** chips (areas; keep the word Topic), "Flagged" (pins.flagged), decision select, presets from `SCHEMA_PRESETS` ("Everything", "Computers", "Computers & displays & storage"). Semantics: OR within a facet, AND across facets. State in the URL query (`?schema=1&types=…&tags=…&topics=…&flagged=1&decision=…`) and mirrored to localStorage `workbench.schema.filter`.
- Click a block or its card → `ThingModal`: name, role, decision, verification, plain attributes (hostname, ip, os, ram_gb, storage_gb, cpu when present), cover photo (`items.get` or the pin's item cover via `photos.url`), links "Open Thing" (`/items/:id`), "Open in Annotate" (`/annotate/:photoId`).
- Cards under the schematic: one per visible block with the same fields.

Gates as Task 2. Click-through: the schematic shows exactly the framed pins; the "Computers" preset hides a keyboard pin and keeps an iMac in Category Furniture; "Focus only" shows flagged only; aspect ratio matches; modal links work; filter survives a reload.

Commit: "Room page: Schema view — a room's framed Things as blocks, with filters and a details modal".

### Task 4: Type picker on the item form; schematic on the item page

**Files:** `src/pages/ItemDetail.tsx` (a **Type** picker next to the Topic dropdown: a select built from `TYPE_TREE`, grouped by root, writes `attributes.type` via `items.patchAttributes`; a **Tags** field writing `attributes.tags`; and, in the Placement pane, for each Photo the Thing is pinned in, a small `PhotoSchematic` with this Thing's block highlighted, click → the room page's Schema view with the Thing selected).

Gates as Task 2. Commit: "Item page: Type and Tags, and a small schematic of where the Thing is pinned".

### Task 5: Backfill script (dry run by default)

**Files:** `scripts/backfill-kind.mjs`: reads `items.listAll` from a base URL (`--base http://127.0.0.1:3002` for a test dev server, default production `http://127.0.0.1:3001`), runs `judgeComputer` and the role→kind derivation for every active Thing, prints a table (id, name, role, brand, proposed type, proposed tags, rule, verdict) and writes nothing. `--apply` writes `type` and `tags` through `items.patchAttributes` for verdict "computer" and for the role-derived kinds only (never "suggested"); `--apply --ids 306,64` writes the given suggested ones after Rick confirms. Never touches other keys. Run it against the seeded test DB first (dry and apply), then dry on production and hand the table to Rick. README: three lines.

Commit: "backfill-kind: classify Things by the evidence ladder, dry run first".

### Task 6: Final review

**Files:** `src/pages/ItemDetail.tsx` (in the Placement pane or next to "Seen in Photos": for each Photo the Thing is pinned in, a small schematic with that Thing's block highlighted and the others dimmed; click opens the Photo's schematic on Map with the Thing selected), `src/pages/RoomPlan.tsx` only if it fits in a few lines (a "Schema" link to Map for this room is enough).

Then final review (opus) against Review Focus, one fix round, Rick's go, restart :3001.
