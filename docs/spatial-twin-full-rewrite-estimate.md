# Spatial twin: full React-native rewrite — cost estimate

**Status: reference only, not the chosen path.** The team decided to mount the
existing vanilla three.js/SVG engine (`/Volumes/T7/lidarventory/app/index.html`,
~1417 lines) imperatively inside a React page in this repo — a `ref` +
`useEffect` hands the canvas/SVG container to the engine largely as-is; React
owns routing and data-fetching via the existing tRPC client
(`src/providers/trpc.tsx`). This document exists to cost out the alternative —
a full idiomatic rewrite into declutter's actual stack (React 19 + Vite +
Radix/shadcn + tRPC + react-router 7) — for a future decision, possibly
executed by a different coding agent (e.g. Cursor). It assumes no prior
context beyond this file and the source it points at.

**Source of truth for behavior to replicate:** `/Volumes/T7/lidarventory/app/index.html`,
read in full for this estimate. **Target data shape:** `db/schema.ts` on
branch `feat/rooms-geometry-schema` (PR #1,
https://github.com/ricktav/declutter/pull/1) — `rooms`, `measurements`,
`items.pos`/`roomId`/`verificationStatus`.

## 1. Component-by-component breakdown

Conventions to match: pages in `src/pages/*.tsx`, shared components in
`src/components/*.tsx` (Radix primitives under `src/components/ui/`), tRPC
hooks via `trpc.<router>.<proc>.useQuery/useMutation`, routes registered in
`src/App.tsx`. No `three` or `@react-three/*` package exists in
`package.json` yet — either approach (imperative mount or full rewrite) adds
`three` as a real dependency for the first time.

| Piece | Current implementation (vanilla) | Rewrite target | Est. effort |
|---|---|---|---|
| **2D plan renderer** | Hand-built SVG string templating (`render2D()`, ~230 lines), raw `pointerdown/move/up` math for drag/rotate/resize, manual `SVGPoint`/`matrixTransform` coordinate conversion | `<RoomPlanCanvas>` component, items as SVG `<g>` children driven by React state, drag/rotate/resize as custom hooks (`useDraggable`, `useRotateHandle`, `useResizeHandle`) wrapping pointer events but committing to state via `setState`/reducer dispatch instead of direct DOM mutation | **5–7 dev-days.** The SVG markup itself ports in a day; the interaction hooks are the real work — must avoid re-rendering the whole plan on every `pointermove` (60fps drag), which means either imperative DOM writes inside the drag handler (defeating the point of "declarative") or careful `useRef`-based transient state with a single commit on `pointerup`. This is the classic drag-in-React tax. |
| **3D twin (three.js scene)** | Imperative: `init3D()`/`buildRoom3D()` build/rebuild a `THREE.Group` per room change, manual raycasting for click/place, manual `OrbitControls`, `GLTFLoader.parse` for GLB attach | See §2 — this is the fork point. Either `@react-three/fiber` (declarative scene graph) or a `<RoomTwin3D>` component that still does everything imperatively inside one `useEffect`, matching the current code almost 1:1 | **8–14 dev-days** depending on the r3f/imperative choice (see §2) — the wide range here dominates the whole estimate |
| **Photo annotation view** | `renderPhotos()`: string-templated `<div class="frame">` overlays positioned by percentage, manual pointer-based drag/resize per frame, separate candidate-frame logic for local (COCO-SSD via CDN `<script>` tag) and AI detections | `<PhotoAnnotator>` component; frames as absolutely-positioned React children; candidate detection reuses declutter's *existing* `annotations.ts`/`ai.ts` vision pipeline instead of the vanilla app's separate COCO-SSD CDN load + `ai-detections.json` fixture — this is a net simplification, not just a port | **4–6 dev-days**, minus roughly a day of savings from dropping the redundant COCO-SSD path in favor of `api/lib/ai.ts` |
| **Photo editor modal** (rotate/crop/zoom/pan) | Canvas-based (`pe.work` is a `<canvas>`, redrawn on every op), custom pointer handling for crop-rect and pan | `<PhotoEditorDialog>` using Radix `Dialog`, same canvas-manipulation core (canvas ops don't benefit from being "more React") wrapped in a component with local state for mode/zoom | **3–4 dev-days** — mostly UI-chrome work; the canvas math ports almost unchanged |
| **Items table view** | `renderItems()`: string-templated `<table>`, client-side filter | `<ItemsTable>` using existing table patterns already in `AreaView.tsx`/`ItemDetail.tsx` (declutter already has item-listing UI to crib from) | **1–2 dev-days** — the cheapest piece, and partially redundant with UI declutter already has |
| **Raw JSON view** | `<pre>{JSON.stringify(DATA)}}</pre>` | Same, trivial | **0.5 dev-day** |
| **Undo/redo stack** | Flat array of `{label, fn}` closures pushed on every mutating action; `fn()` replays the inverse mutation directly against the shared `room`/`DATA` object graph | See §3 — this is the highest-risk single piece to port, not because it's big, but because its correctness depends on direct object mutation that a reducer-based rewrite removes | **4–6 dev-days**, mostly re-design, not typing |
| **Persistence layer** (overlay keys → SSOT) | 9 `localStorage` keys mirrored to a single-table SQLite overlay store (`app/server.py`) | Already superseded — PR #1 replaces this with `rooms`/`measurements`/`items.pos`/`verificationStatus` in the real schema. Rewrite work here is "wire tRPC mutations to the new routers," not persistence design | **2–3 dev-days** (mutation hooks + optimistic updates for drag/rotate/resize, since those fire on every pointer move and can't wait for a round-trip per frame) |
| **Wall fixtures, stacking, grouping** (business logic: `applyStacking`, `findHost`, wall-pin geometry) | Plain functions over the shared object graph | Port as pure functions, called from mutation handlers/reducer — this logic is UI-framework-agnostic and is the easiest 1:1 port in the whole codebase | **1–2 dev-days** |

**Subtotal, component work: 28.5–41.5 dev-days**, before integration, testing, and the fork-point decision below.

## 2. The fork: react-three-fiber vs. imperative three.js-in-a-ref

**Option A — plain three.js, imperatively managed inside a `useEffect` + ref**
(the same pattern used for the *mounting* approach already chosen, just with
more of the surrounding UI as real React):
- Bundle cost: `three` alone (~150KB gzipped for the core + loaders used
  here — `GLTFLoader`, `OrbitControls`). No extra abstraction layer.
- Ecosystem fit: the current GLB-attach code (`attachModel3D`,
  `GLTFLoader.parse`, bounding-box auto-scale) ports with almost no changes —
  it's already vanilla Three.js API calls.
- Learning curve: none beyond what maintaining the current app already
  requires.
- State sync: manual. React state changes (item moved, GLB attached) must be
  pushed into the scene graph by hand in an effect that diffs against what's
  already built — exactly what `buildRoom3D()` does today, just triggered by
  a `useEffect` dependency array instead of being called directly.

**Option B — `@react-three/fiber` + `@react-three/drei`**
- Bundle cost: `three` + `@react-three/fiber` + (usually) `@react-three/drei`
  for `OrbitControls`/`useGLTF` — roughly another 40–60KB gzipped on top of
  bare three.js, plus a reconciler layer.
- Ecosystem fit: `useGLTF`/`<primitive object={...}>` handle GLB loading more
  declaratively, but the *scaling-to-footprint* and *stacking-height*
  math (`attachModel3D`'s bounding-box normalization) is still imperative
  logic that has to live in a `useEffect` or `useLayoutEffect` regardless —
  r3f doesn't remove this class of code, it just changes where it lives.
- Learning curve: real, for whoever executes this (Cursor or otherwise) —
  r3f's reconciler model (React components that are actually three.js
  objects) is a distinct mental model from both plain React DOM and plain
  three.js, and mixing it with drag-driven, 60fps position updates (items
  being placed/moved) needs care to avoid React re-render overhead on every
  frame (r3f mitigates this with `useFrame` outside React's render cycle,
  but that's exactly the "imperative escape hatch" Option A already uses —
  so the actual code inside the hot path ends up looking similar either way).
- State sync: closer to "React-native" for static scene composition (walls,
  floor, static meshes as JSX), but item drag/rotate/resize still needs an
  imperative path for performance, same as Option A.

**Recommendation if this is ever executed: Option A.** r3f's main win is
composability for a scene that's mostly declarative (many independent
components rendering their own meshes); this scene is mostly *one* dynamic,
frequently-repositioned object graph driven by drag interactions, which is
r3f's weaker case. Option A also has zero new-library risk for whoever picks
this up. This adds ~2–3 dev-days back onto the 8–14 day 3D-twin estimate
above if Option B is chosen instead, for a decision that doesn't buy much.

## 3. Risk areas specific to this codebase

**Undo stack.** The current implementation works because every mutation is a
closure over the *same* mutable object (`room`, found via
`DATA.rooms.find(...)`) — `pushUndo(label, () => { it.pos = prev; ... })`
captures `it` by reference and mutates it back in place. A React rewrite
that moves state into `useState`/`useReducer` breaks this assumption: you
cannot mutate a piece of React state from inside a stale closure and expect
a re-render. The undo stack needs to become either (a) a reducer with a
`{past: Action[], present: State}` pattern (standard, but a real redesign —
every action listed in the table above needs an inverse *action*, not an
inverse *closure*), or (b) a snapshot-based undo (store full state
snapshots, restore wholesale) which is simpler to implement correctly but
more memory-hungry and loses the current "single field changed" granularity
that makes toasts like `Undid: rotate "chair"` cheap to produce. **Do not
attempt to port the closure-based stack as-is into a React state world — it
will produce silent, hard-to-reproduce bugs** (undo restoring a value into
an object no longer referenced by current state).

**Drag/rotate/resize handles.** Currently raw `pointerdown/move/up` math
directly against SVG `data-id` attributes and `SVGPoint.matrixTransform`.
This logic is *correct and non-trivial* (handles the SVG viewBox scale
factor, room-bounds clamping, group-aware multi-item drag, 15°-snap vs.
free-rotate on shift). Porting it is mechanical but must be done by someone
who traces through the coordinate math carefully — a naive "convert to
React" pass that recomputes bounding boxes from `getBoundingClientRect()` on
every event instead of caching the SVG CTM per drag (as the original does)
will be visibly janky under fast pointer movement. Treat this as a port, not
a rewrite-from-intent.

**Overlay-key persistence → new schema.** No longer really a risk — PR #1
already replaces the destination (`rooms`/`measurements`/`items.pos`/
`items.verificationStatus`), so this is now "write tRPC routers and mutation
hooks against a known schema," not an open design question. The remaining
work is: (a) `rooms`/`measurements` routers don't exist yet (needed
regardless of imperative-mount or full-rewrite — see PR plan, next steps
are `feat/rooms-geometry-api`), and (b) whichever approach is chosen, the
verification-gate semantics (`detected|confirmed|rejected` on `items`) must
be wired into whatever "confirm/reject" UI replaces the current
`setStatus()` global function.

## 4. Total estimate and phasing

**Total: 33–48 dev-days** (component work 28.5–41.5, plus 4.5–6.5 days of
integration/testing/cross-view wiring not itemized above — e.g. the 2D/3D
selection-sync, the "jump to photo frame" cross-view navigation, and
`refresh()`'s current job of keeping five views consistent, which becomes
either global state or a shared query-invalidation strategy in the rewrite).

**If this is greenlit later, recommended phasing** (each phase
independently shippable and reviewable):

1. **Data layer first**: `rooms`/`measurements` tRPC routers + hooks, no UI
   change yet. Builds on PR #1's schema.
2. **Items table + JSON view**: cheapest, lowest-risk, validates the tRPC
   wiring end-to-end before touching anything interactive.
3. **2D plan, read-only** (render only, no drag/rotate/resize yet): proves
   the SVG-in-React rendering approach and room-geometry data flow.
4. **2D plan, interactive**: add drag/rotate/resize/grouping — the highest
   per-line risk, isolated to its own phase so it doesn't block the rest.
5. **Undo/redo**: only once the interactive 2D plan (the majority of
   undoable actions) exists, since the undo *design* depends on knowing the
   real action shapes.
6. **3D twin**: independently shippable once room geometry + items exist in
   the new data layer; doesn't depend on 2D plan being interactive.
7. **Photo annotation + editor**: independently shippable at any point after
   phase 1; good candidate to parallelize with phase 4–6 if two people/agents
   are working this.

Phases 2–3 and 6–7 could run in parallel across two engineers/agents; phases
4–5 are sequential and should not be split.

## 5. Non-recommendation

This document is a cost estimate for future reference, produced on request
so the option is priced out before anyone commits to it — **it is not a
recommendation to do this rewrite now.** The chosen path, already in
progress, is mounting the existing vanilla engine inside a React page (ref +
`useEffect`), which avoids essentially all of the risk and cost itemized
above while still achieving "same repo, same deploy, same DB" with Kimi's
ongoing work. Revisit this document if/when: the vanilla engine becomes a
maintenance bottleneck, an iOS RoomPlan app needs to share significant
client-side logic with the web twin (see open question: whether a
React-native/Expo port would reuse more of a "full rewrite" React codebase
than the vanilla one — likely yes for state/data-layer code, likely
irrelevant for the three.js rendering core either way, since neither
vanilla JS nor React DOM code ports to iOS directly), or headcount exists to
absorb 33–48 dev-days of rewrite risk for a UI that currently works.
