# Rooms Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rooms` the only location concept: an item is in a room (or unplaced in a house), a room has a floor, and the app works inside one house per session.

**Architecture:** Every free-text `(houseId, floor, room)` tuple on items and attachments becomes a `rooms` row (scanned or not) referenced by `roomId`; floor moves onto the room. A server-side house context (`x-house-id` header) and a client `HouseProvider` make "the current building" the default scope for every list and picker. The migration runs in two schema steps with a tested, idempotent backfill between them so production data moves before any column is dropped.

**Tech Stack:** Drizzle ORM + drizzle-kit migrations (MySQL 8), tRPC 11, React 19, vitest on the test-DB seam (`api/test/db.ts`, plan `2026-10-02-test-db-seam.md`).

**Spec:** Architecture review §4.1 and §9 (https://claude.ai/artifact/EA2FJfZuLd8Daco9NwZjxF), the decisions in `/Users/ricktav/.claude/projects/-Volumes-T7-declutter/memory/homebase-review-decisions.md`, and two product rules given on 2026-10-02:

1. *A building is about its rooms. Floor is a variable on the room: set once when the room is created, used only to filter or group in views, never a step in a location pick.*
2. *Working in the app is per building. A session is in the context of one house all the time; a new session defaults to the last used house, or asks you to switch.*

## Design (the part of the spec this plan fixes in code)

**Data model after this plan**

| table | location columns | rule |
|---|---|---|
| `houses` | — | `floors` JSON column dropped; a house's floors are the distinct `rooms.floor` values. |
| `rooms` | `houseId` NN, `floor` NULL, `name` NN, geometry columns all nullable, `source` ∈ mappedin/roomplan/manual | `(houseId, name)` unique, case-insensitive by collation. A room without geometry is just a room; a later scan attaches walls to the same row. |
| `items` | `roomId` NULL, `houseId` NULL | **Invariant:** when `roomId` is set, `houseId` equals that room's `houseId`. `houseId` with `roomId` null means "in this house, not placed in a room yet". Both are written only through `setItemLocation()`. `floor` and `room` columns dropped. |
| `attachments` | `roomId` NULL | "location photo" = image with `roomId` and no `itemId`. `houseId`, `floor`, `room` columns dropped. |

Why `items.houseId` survives (the review's target dropped it): the Flow "Act" tab and the Dashboard scope by house, and an item can be in a house before anyone has put it in a room. A derived-only house would make such items vanish from every house-scoped view. One column plus one invariant, enforced in one function and one test, is cheaper than a sentinel "Unplaced" room per house.

**House context**

- Client keeps `declutter.houseId` in localStorage, exposes it through `HouseProvider` / `useHouse()`, and sends it on every tRPC call as the `x-house-id` header. Switching house invalidates every query.
- Server parses the header into `ctx.houseId: number | null`. Procedures that list things use it as the default scope when their input gives no `houseId`. Explicit input always wins, so cross-house views (Map, Settings → Houses) still work.
- First run: no stored house → the first house by id; no houses at all → Dashboard shows the "Add house" dialog, nothing else needs a house to render.

**Picker contract:** choose a house (prefilled from context, usually hidden) then a room. Typing a name that does not exist offers "create room …" with an optional floor select inside the create row. Floor never appears as a separate step when choosing an existing room.

**Out of scope, deliberately**

- Merging captures and image attachments into one `photos` table (next plan).
- Drag-and-drop of items between rooms or onto plans. Rick wants this later as a GUI feature; the picker and the `items.update({roomId})` mutation this plan builds are what it will call.
- Real foreign keys with cascade (router/FK cleanup plan, after photos).

## Global Constraints

- No new npm dependencies.
- Every DB-touching change is covered by a vitest test on the seam: tests import `getTestDb`/`resetTestDb` from `api/test/db.ts`, call `resetTestDb()` in `beforeEach`, and never set `DATABASE_URL`.
- Schema changes go through `npm run db:generate` into `db/migrations/` (next tags: `0003_rooms_floor`, `0004_drop_location_strings`). Never `db:push` against production in this plan.
- The two-step order is fixed: columns are dropped (Task 9) only after the backfill has run on production (Task 10 step 3) and both front ends compile without the old columns.
- `tsc -b`, `npx eslint api src`, `npm test` and `npm run build` pass at the end of every task.
- Copy stays English; user-facing room labels are shown as `name` with the floor as a secondary badge, never `floor · room` joined into one string.
- Commit after every task with the message given in that task.

## Review Focus

1. **Two rooms with the same name in one house, differing only by case** ("Keuken" / "keuken"). A reasonable person expects one room. Pinned by the unique index test in Task 2 and the `ensureRoom` case-insensitive test in Task 4.
2. **An item moved into a room of another house.** The item must follow the room's house, never keep a stale `houseId`. Pinned by the `setItemLocation` invariant test in Task 4.
3. **Backfill run twice, or interrupted halfway.** Must not create duplicate rooms or re-link items. Pinned by the idempotency test in Task 3.
4. **A request with no `x-house-id` header** (Telegram bot, curl, a browser before the provider stored anything). Lists must return everything, not throw. Pinned by the context test in Task 1 and the `rooms.list` no-context test in Task 4.
5. **Merging a scanned room into another scanned room.** Walls cannot be combined; the merge must refuse instead of silently dropping geometry. Pinned by the `rooms.merge` test in Task 4.

---

## File Structure

- Create `api/lib/houseContext.ts` — parse `x-house-id` → `number | null`.
- Modify `api/context.ts` — add `houseId` to `TrpcContext`.
- Create `src/context/house.tsx` — `HouseProvider`, `useHouse()`, `getStoredHouseId()`.
- Create `src/components/HouseSwitcher.tsx` — the chip in the Workbench sidebar and the Flow header.
- Modify `src/providers/trpc.tsx` — send `x-house-id`.
- Modify `db/schema.ts` — rooms.floor, unique index, (Task 9) drop columns.
- Create `db/adopt-migrations.mjs` — mark the baseline as applied on a `db:push`-managed database.
- Create `api/lib/backfillRooms.ts` + `scripts/backfill-rooms.mjs` — strings → rooms, idempotent.
- Create `api/lib/location.ts` — `ensureRoom`, `setItemLocation`, `roomSummary`; the only writers of `items.roomId/houseId`.
- Modify `api/routers/rooms.ts` — becomes the one rooms API: `list`, `get`, `ensure`, `create`, `update`, `merge`, `remove`, `cutFromRoom`, `upsertFromScan`.
- Modify `api/routers/houses.ts`, `map.ts`, `items.ts`, `inbox.ts`, `attachments.ts`, `areas.ts` — roomId instead of strings; remove `houses.rooms`, `map.listLocations`, `map.renameLocation`, `rooms.listAll`, `rooms.listByHouse`, `rooms.unlinkedLocations`.
- Rewrite `src/components/RoomPicker.tsx`; rewrite `src/lib/lastLocation.ts` → `src/lib/lastRoom.ts`; delete `src/components/FloorsEditor.tsx`.
- Modify every consumer listed in Tasks 6–8.
- Tests under `api/test/` and `api/lib/__tests__/` (vitest includes `api/**/*.test.ts`).

---

### Task 1: House context (server header, client provider, switcher)

**Files:**
- Create: `api/lib/houseContext.ts`
- Modify: `api/context.ts`
- Modify: `api/routers/areas.ts:18-36` (use `ctx.houseId` as default)
- Create: `src/context/house.tsx`, `src/components/HouseSwitcher.tsx`
- Modify: `src/providers/trpc.tsx`, `src/main.tsx`, `src/components/Layout.tsx`, `src/flow/main.tsx`, `src/flow/FlowApp.tsx:60-70`
- Test: `api/lib/__tests__/houseContext.test.ts`, `api/test/areas.test.ts`

**Interfaces:**
- Produces: `parseHouseId(headers: Headers): number | null`; `TrpcContext.houseId: number | null`; client `useHouse(): { houseId: number | null; setHouseId(id: number | null): void }`, `getStoredHouseId(): number | null`, `HOUSE_STORAGE_KEY = "declutter.houseId"`.

- [ ] **Step 1: Write the failing server tests**

```typescript
// api/lib/__tests__/houseContext.test.ts
import { describe, expect, it } from "vitest";
import { parseHouseId } from "../houseContext";

describe("parseHouseId", () => {
  it("returns null without the header", () => {
    expect(parseHouseId(new Headers())).toBeNull();
  });
  it("parses a positive integer", () => {
    expect(parseHouseId(new Headers({ "x-house-id": "2" }))).toBe(2);
  });
  it("rejects garbage, zero and negatives", () => {
    expect(parseHouseId(new Headers({ "x-house-id": "abc" }))).toBeNull();
    expect(parseHouseId(new Headers({ "x-house-id": "0" }))).toBeNull();
    expect(parseHouseId(new Headers({ "x-house-id": "-3" }))).toBeNull();
  });
});
```

```typescript
// api/test/areas.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { appRouter } from "../router";

/** Build a caller the way a request with (or without) the house header would. */
export function callerFor(houseId: number | null) {
  const headers = new Headers({ authorization: "Bearer " + (process.env.APP_TOKEN ?? "") });
  if (houseId != null) headers.set("x-house-id", String(houseId));
  return appRouter.createCaller({
    req: new Request("http://test/api/trpc", { headers }),
    resHeaders: new Headers(),
    houseId,
  });
}

beforeEach(async () => {
  await resetTestDb();
});

describe("areas.list house scoping", () => {
  it("counts only the context house's items when no houseId input is given", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    await db.insert(items).values([
      { areaId, name: "in A", houseId: h1 },
      { areaId, name: "in B", houseId: h2 },
    ]);

    const scoped = await callerFor(h1).areas.list();
    expect(scoped[0].itemCount).toBe(1);

    const all = await callerFor(null).areas.list();
    expect(all[0].itemCount).toBe(2);

    const explicit = await callerFor(h1).areas.list({ houseId: h2 });
    expect(explicit[0].itemCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/lib/__tests__/houseContext.test.ts api/test/areas.test.ts`
Expected: FAIL — `Cannot find module '../houseContext'`; `houseId` not in `TrpcContext`.

- [ ] **Step 3: Server implementation**

```typescript
// api/lib/houseContext.ts
/** The house the client is working in, sent as `x-house-id` on every call. */
export function parseHouseId(headers: Headers): number | null {
  const raw = headers.get("x-house-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
```

```typescript
// api/context.ts
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { parseHouseId } from "./lib/houseContext";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  /** current building, from the x-house-id header; null = no context */
  houseId: number | null;
};

export async function createContext(opts: FetchCreateContextFnOptions): Promise<TrpcContext> {
  return { req: opts.req, resHeaders: opts.resHeaders, houseId: parseHouseId(opts.req.headers) };
}
```

In `api/routers/areas.ts`, change the `list` procedure so the context house is the default:

```typescript
  list: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      // explicit input wins; `null` explicitly means "all houses"
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      const db = getDb();
      const counts = await db
        .select({ areaId: items.areaId, count: sql<number>`count(*)` })
        .from(items)
        .where(houseId != null ? and(eq(items.status, "active"), eq(items.houseId, houseId)) : eq(items.status, "active"))
        .groupBy(items.areaId);
      // ...rest of the existing body unchanged
```

(Keep whatever the existing body does after the count query; only the first lines change. If the file already groups counts differently, keep that shape and only replace the `where`.)

- [ ] **Step 4: Run server tests to verify they pass**

Run: `npx vitest run api/lib/__tests__/houseContext.test.ts api/test/areas.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Client provider, header, switcher**

```tsx
// src/context/house.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/providers/trpc";

export const HOUSE_STORAGE_KEY = "declutter.houseId";

export function getStoredHouseId(): number | null {
  try {
    const raw = localStorage.getItem(HOUSE_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function storeHouseId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(HOUSE_STORAGE_KEY);
    else localStorage.setItem(HOUSE_STORAGE_KEY, String(id));
  } catch {
    // storage unavailable: the header still carries this session's choice
  }
}

type HouseState = {
  houseId: number | null;
  setHouseId: (id: number | null) => void;
  /** every house, for the switcher */
  houses: { id: number; name: string }[];
};

const Ctx = createContext<HouseState | null>(null);

/**
 * "Which building am I working in." One per session, remembered per
 * browser. Every tRPC call carries it (see providers/trpc.tsx) so server
 * lists default to this house.
 */
export function HouseProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const houses = trpc.houses.list.useQuery();
  const [houseId, setState] = useState<number | null>(() => getStoredHouseId());

  // first run, or the stored house was deleted: fall back to the first house
  useEffect(() => {
    if (!houses.data) return;
    const valid = houseId != null && houses.data.some((h) => h.id === houseId);
    if (!valid) {
      const next = houses.data[0]?.id ?? null;
      setState(next);
      storeHouseId(next);
      if (next !== houseId) utils.invalidate();
    }
  }, [houses.data, houseId, utils]);

  const setHouseId = useCallback(
    (id: number | null) => {
      setState(id);
      storeHouseId(id);
      // every list in the app is scoped by the header; refetch all of them
      utils.invalidate();
    },
    [utils],
  );

  const value = useMemo(
    () => ({ houseId, setHouseId, houses: (houses.data ?? []).map((h) => ({ id: h.id, name: h.name })) }),
    [houseId, setHouseId, houses.data],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHouse(): HouseState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useHouse outside HouseProvider");
  return v;
}
```

```tsx
// src/components/HouseSwitcher.tsx
import { Home } from "lucide-react";
import { useHouse } from "@/context/house";

/** The one place a session changes building. Rendered in both shells. */
export function HouseSwitcher({ dark = false }: { dark?: boolean }) {
  const { houseId, setHouseId, houses } = useHouse();
  if (houses.length === 0) return null;
  return (
    <label className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${dark ? "bg-[#32361f] text-[#e0e0d0]" : "bg-muted"}`}>
      <Home className="h-4 w-4 shrink-0 opacity-70" />
      <select
        id="house-switcher"
        aria-label="Current house"
        className="min-w-0 flex-1 bg-transparent outline-none"
        value={houseId ?? ""}
        onChange={(e) => setHouseId(e.target.value ? Number(e.target.value) : null)}
      >
        {houses.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </label>
  );
}
```

In `src/providers/trpc.tsx` replace the `headers` line added in phase 1:

```typescript
import { getStoredHouseId } from "@/context/house";
// ...
      headers: () => {
        const h = getStoredHouseId();
        return { ...authHeaders(), ...(h != null ? { "x-house-id": String(h) } : {}) };
      },
```

(`getStoredHouseId` reads localStorage directly so the client does not depend on React state; `HouseProvider.setHouseId` writes the same key before invalidating.)

In `src/main.tsx` wrap `App` inside `AuthGate` with `HouseProvider`:

```tsx
        <AuthGate>
          <HouseProvider>
            <App />
          </HouseProvider>
        </AuthGate>
```

In `src/components/Layout.tsx`, inside the `sidebar` fragment directly after the `⌂ HomeBase` header block (before `<nav className="px-2 space-y-0.5">`), add:

```tsx
      <div className="px-2 pb-2">
        <HouseSwitcher dark />
      </div>
```

and import `HouseSwitcher`. In `src/flow/main.tsx` wrap `FlowApp` the same way as `App` (inside `AuthGate`, with `HouseProvider`). In `src/flow/FlowApp.tsx` the header's "Where are you?" button stays; add `<HouseSwitcher />` beside it (this task only adds the switcher; Task 8 rewires "here").

- [ ] **Step 6: Verify**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean. Start `npm run dev`, open the Workbench: the sidebar shows the switcher with your houses; switching house updates the Dashboard topic counts without a reload; the network tab shows `x-house-id` on tRPC requests.

- [ ] **Step 7: Commit**

```bash
git add api/lib/houseContext.ts api/context.ts api/routers/areas.ts api/lib/__tests__ api/test/areas.test.ts src/context/house.tsx src/components/HouseSwitcher.tsx src/providers/trpc.tsx src/main.tsx src/components/Layout.tsx src/flow/main.tsx src/flow/FlowApp.tsx
git commit -m "Add house context: x-house-id header, HouseProvider, switcher in both shells"
```

---

### Task 2: Schema step A — rooms.floor, unique room names, migration adoption

**Files:**
- Modify: `db/schema.ts:104-132` (rooms)
- Create: `db/migrations/0003_rooms_floor.sql` (generated)
- Create: `db/adopt-migrations.mjs`
- Modify: `package.json` scripts, `README.md`
- Test: `api/test/rooms-schema.test.ts`

**Interfaces:**
- Produces: `rooms.floor: varchar(32) | null`; unique index `rooms_house_name_uq (houseId, name)`.

- [ ] **Step 1: Write the failing test**

```typescript
// api/test/rooms-schema.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { houses, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";

beforeEach(async () => {
  await resetTestDb();
});

describe("rooms schema", () => {
  it("stores a floor on the room and refuses a duplicate name in one house, case-insensitively", async () => {
    const db = getTestDb();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "H" }).$returningId();
    await db.insert(rooms).values({ houseId, name: "Keuken", floor: "ground", source: "manual" });
    const [row] = await db.select().from(rooms);
    expect(row.floor).toBe("ground");
    expect(row.walls).toBeNull();

    await expect(
      db.insert(rooms).values({ houseId, name: "keuken", source: "manual" }),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it("allows the same room name in two different houses", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    await db.insert(rooms).values([
      { houseId: h1, name: "Keuken", source: "manual" },
      { houseId: h2, name: "Keuken", source: "manual" },
    ]);
    expect(await db.select().from(rooms)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/test/rooms-schema.test.ts`
Expected: FAIL — `floor` is not a column (type error or `Unknown column 'floor'`).

- [ ] **Step 3: Schema change and migration**

In `db/schema.ts`, in the `rooms` table add after `name`:

```typescript
    // the room's floor. A property of the room, set once; views filter or
    // group by it, pickers never ask for it as a step (product rule 1)
    floor: varchar("floor", { length: 32 }),
```

and replace the index tuple with:

```typescript
  (t) => [
    index("rooms_house_idx").on(t.houseId),
    index("rooms_parent_idx").on(t.parentRoomId),
    // one room per name per house; MySQL's default utf8mb4 collation is
    // case-insensitive, so "Keuken" and "keuken" collide, as intended
    uniqueIndex("rooms_house_name_uq").on(t.houseId, t.name),
  ],
```

Add `uniqueIndex` to the import from `drizzle-orm/mysql-core`.

Run: `npm run db:generate -- --name rooms_floor`
Expected: `db/migrations/0003_rooms_floor.sql` containing `ALTER TABLE rooms ADD floor varchar(32)` and `CREATE UNIQUE INDEX rooms_house_name_uq ON rooms (houseId, name)`. Read it; it must not contain any DROP.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/test/rooms-schema.test.ts`
Expected: PASS — 2 tests (globalSetup applies 0003 to the test DB).

- [ ] **Step 5: Migration adoption script for the production database**

Production was created with `db:push`, so `drizzle-kit migrate` would try to re-run `0000_baseline`. Drizzle's migrator only looks at the newest row of `__drizzle_migrations` and runs journal entries whose `when` is newer than that row's `created_at`. Marking the latest already-applied tag is enough.

```javascript
// db/adopt-migrations.mjs
// Usage: node db/adopt-migrations.mjs <tag>
//   Marks every migration up to and including <tag> as applied, for a
//   database whose schema was created with `drizzle-kit push`. Run once,
//   then use `npm run db:migrate` from then on.
import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import mysql from "mysql2/promise";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node db/adopt-migrations.mjs <migration tag, e.g. 0002_item_decision>");
  process.exit(1);
}
const journal = JSON.parse(fs.readFileSync("db/migrations/meta/_journal.json", "utf8"));
const entry = journal.entries.find((e) => e.tag === tag);
if (!entry) {
  console.error(`tag ${tag} not found in db/migrations/meta/_journal.json`);
  process.exit(1);
}
const sqlText = fs.readFileSync(`db/migrations/${tag}.sql`, "utf8");
const hash = crypto.createHash("sha256").update(sqlText).digest("hex");

const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL });
await conn.query(
  "create table if not exists `__drizzle_migrations` (id serial primary key, hash text not null, created_at bigint)",
);
const [rows] = await conn.query("select created_at from `__drizzle_migrations` order by created_at desc limit 1");
if (rows.length && Number(rows[0].created_at) >= entry.when) {
  console.log(`already at or past ${tag}; nothing to do`);
} else {
  await conn.query("insert into `__drizzle_migrations` (hash, created_at) values (?, ?)", [hash, entry.when]);
  console.log(`marked ${tag} (${entry.when}) as applied`);
}
await conn.end();
```

Add to `package.json` scripts: `"db:adopt": "node db/adopt-migrations.mjs"`.

In `README.md` replace the sentence "An existing database that was created with `db:push` can keep using `db:push`; the `0000_baseline` migration describes that same state." with:

```
An existing database that was created with `db:push` is switched to migrations once with
`npm run db:adopt 0002_item_decision` (the last tag it already matches); after that, only
`npm run db:migrate`.
```

- [ ] **Step 6: Verify and commit**

Run: `npm run check && npx eslint api db && npm test`
Expected: clean; `npm test` shows 0003 applied once in the globalSetup output.

```bash
git add db/schema.ts db/migrations package.json README.md db/adopt-migrations.mjs api/test/rooms-schema.test.ts
git commit -m "Add rooms.floor and a unique room name per house; migration adoption script"
```

---

### Task 3: Backfill — every location string becomes a room

**Files:**
- Create: `api/lib/backfillRooms.ts`
- Create: `scripts/backfill-rooms.mjs`
- Modify: `package.json` scripts
- Test: `api/test/backfillRooms.test.ts`

**Interfaces:**
- Produces: `backfillRooms(db: Db): Promise<{ roomsCreated: number; itemsLinked: number; attachmentsLinked: number; floorsSet: number }>`, where `Db` is the type returned by `getDb()`.

- [ ] **Step 1: Write the failing tests**

```typescript
// api/test/backfillRooms.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { backfillRooms } from "../lib/backfillRooms";

beforeEach(async () => {
  await resetTestDb();
});

async function seedHouseAndArea() {
  const db = getTestDb();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "f", name: "Furniture" }).$returningId();
  return { db, houseId, areaId };
}

describe("backfillRooms", () => {
  it("creates one room per distinct (house, room) string, carries the floor, links items", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    await db.insert(items).values([
      { areaId, name: "a", houseId, floor: "ground", room: "Keuken" },
      { areaId, name: "b", houseId, floor: "ground", room: "keuken " }, // case + whitespace
      { areaId, name: "c", houseId, floor: "attic", room: "Washok" },
      { areaId, name: "d", houseId }, // in the house, no room: stays unplaced
      { areaId, name: "e" }, // nowhere
    ]);

    const r = await backfillRooms(db);
    expect(r).toMatchObject({ roomsCreated: 2, itemsLinked: 3 });

    const all = await db.select().from(rooms).orderBy(rooms.name);
    expect(all.map((x) => [x.name, x.floor, x.source])).toEqual([
      ["Keuken", "ground", "manual"],
      ["Washok", "attic", "manual"],
    ]);
    const keuken = all[0];
    const linked = await db.select({ name: items.name, roomId: items.roomId, houseId: items.houseId }).from(items).orderBy(items.name);
    expect(linked).toEqual([
      { name: "a", roomId: keuken.id, houseId },
      { name: "b", roomId: keuken.id, houseId },
      { name: "c", roomId: all[1].id, houseId },
      { name: "d", roomId: null, houseId },
      { name: "e", roomId: null, houseId: null },
    ]);
  });

  it("links to an existing scanned room by name instead of creating a twin, and fills its floor", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    const [{ id: scanned }] = await db
      .insert(rooms)
      .values({ houseId, name: "Woonkamer", source: "mappedin", walls: [], openings: [] })
      .$returningId();
    await db.insert(items).values({ areaId, name: "sofa", houseId, floor: "ground", room: "woonkamer" });

    const r = await backfillRooms(db);
    expect(r.roomsCreated).toBe(0);
    const [room] = await db.select().from(rooms);
    expect(room.id).toBe(scanned);
    expect(room.floor).toBe("ground");
    const [it] = await db.select().from(items);
    expect(it.roomId).toBe(scanned);
  });

  it("keeps an item's existing roomId (geometry truth) and only uses the strings to set the room's floor", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    const [{ id: roomId }] = await db.insert(rooms).values({ houseId, name: "Floor 2", source: "mappedin" }).$returningId();
    await db.insert(items).values({ areaId, name: "desk", houseId, roomId, floor: "attic", room: "Zolderkamer" });

    await backfillRooms(db);
    const [it] = await db.select().from(items);
    expect(it.roomId).toBe(roomId); // not re-pointed at a new "Zolderkamer" room
    const all = await db.select().from(rooms);
    expect(all).toHaveLength(1);
    expect(all[0].floor).toBe("attic");
  });

  it("maps location photos (attachments with room text) to roomId", async () => {
    const { db, houseId } = await seedHouseAndArea();
    await db.insert(attachments).values({ kind: "image", houseId, floor: "ground", room: "Eetkamer", title: "Location photo" });
    const r = await backfillRooms(db);
    expect(r.attachmentsLinked).toBe(1);
    const [room] = await db.select().from(rooms);
    const [att] = await db.select().from(attachments);
    expect(att.roomId).toBe(room.id);
  });

  it("is idempotent", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    await db.insert(items).values({ areaId, name: "a", houseId, floor: "ground", room: "Keuken" });
    await backfillRooms(db);
    const second = await backfillRooms(db);
    expect(second).toEqual({ roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 });
    expect(await db.select().from(rooms)).toHaveLength(1);
    expect((await db.select().from(items).where(eq(items.name, "a")))[0].roomId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/backfillRooms.test.ts`
Expected: FAIL — `Cannot find module '../lib/backfillRooms'`.

- [ ] **Step 3: Implementation**

```typescript
// api/lib/backfillRooms.ts
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { attachments, items, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * One-shot, idempotent: turn every free-text (houseId, floor, room) tuple on
 * items and attachments into a rooms row and link by roomId. Safe to re-run;
 * does nothing once every string has a room.
 *
 * Rules
 *  - match an existing room in the same house by name, case-insensitively
 *  - an item that already has a roomId keeps it (scan geometry is truth);
 *    its strings only contribute a floor to that room if the room has none
 *  - a room created here is source "manual", floor from the first item
 *  - rows with no house, or no room text, are left alone
 */
export async function backfillRooms(db: Db) {
  const result = { roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 };

  const existing = await db.select().from(rooms);
  const byKey = new Map<string, { id: number; floor: string | null }>();
  for (const r of existing) byKey.set(`${r.houseId}|${norm(r.name)}`, { id: r.id, floor: r.floor });

  async function roomFor(houseId: number, name: string, floor: string | null): Promise<number> {
    const key = `${houseId}|${norm(name)}`;
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.floor && floor) {
        await db.update(rooms).set({ floor }).where(eq(rooms.id, hit.id));
        hit.floor = floor;
        result.floorsSet++;
      }
      return hit.id;
    }
    const [{ id }] = await db
      .insert(rooms)
      .values({ houseId, name: name.trim(), floor: floor || null, source: "manual" })
      .$returningId();
    byKey.set(key, { id, floor: floor || null });
    result.roomsCreated++;
    return id;
  }

  // 1. items that already sit in a room: only donate a floor
  const placed = await db
    .select({ roomId: items.roomId, floor: items.floor })
    .from(items)
    .where(and(isNotNull(items.roomId), isNotNull(items.floor)));
  for (const p of placed) {
    const room = existing.find((r) => r.id === p.roomId);
    const entry = room ? byKey.get(`${room.houseId}|${norm(room.name)}`) : undefined;
    if (room && entry && !entry.floor && p.floor) {
      await db.update(rooms).set({ floor: p.floor }).where(eq(rooms.id, room.id));
      entry.floor = p.floor;
      result.floorsSet++;
    }
  }

  // 2. items with room text but no roomId
  const unplaced = await db
    .select({ id: items.id, houseId: items.houseId, floor: items.floor, room: items.room })
    .from(items)
    .where(and(isNull(items.roomId), isNotNull(items.houseId), isNotNull(items.room)));
  for (const it of unplaced) {
    if (!it.room?.trim() || it.houseId == null) continue;
    const roomId = await roomFor(it.houseId, it.room, it.floor);
    await db.update(items).set({ roomId }).where(eq(items.id, it.id));
    result.itemsLinked++;
  }

  // 3. location photos
  const photos = await db
    .select({ id: attachments.id, houseId: attachments.houseId, floor: attachments.floor, room: attachments.room })
    .from(attachments)
    .where(and(isNull(attachments.roomId), isNotNull(attachments.houseId), isNotNull(attachments.room)));
  for (const a of photos) {
    if (!a.room?.trim() || a.houseId == null) continue;
    const roomId = await roomFor(a.houseId, a.room, a.floor);
    await db.update(attachments).set({ roomId }).where(eq(attachments.id, a.id));
    result.attachmentsLinked++;
  }

  // 4. invariant: houseId follows the room
  await db.execute(sql`update items i join rooms r on r.id = i.roomId set i.houseId = r.houseId where i.houseId <> r.houseId or i.houseId is null`);

  return result;
}
```

```javascript
// scripts/backfill-rooms.mjs
// Usage: npx tsx scripts/backfill-rooms.mjs   (reads DATABASE_URL from .env)
import "dotenv/config";
import { getDb } from "../api/queries/connection.ts";
import { backfillRooms } from "../api/lib/backfillRooms.ts";

const r = await backfillRooms(getDb());
console.log(r);
process.exit(0);
```

Add to `package.json` scripts: `"db:backfill-rooms": "tsx scripts/backfill-rooms.mjs"`. (`tsx` is already present through drizzle-kit's toolchain; if `npx tsx` is not resolvable, add `tsx` as a devDependency, which is the one allowed exception to the no-new-deps rule because it is a build tool, not shipped code.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/test/backfillRooms.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Dry run against a copy of production data (read-only check)**

Run against the live DB, read-only, to preview what the backfill would do:

```bash
node -e 'import("dotenv/config").then(async()=>{const m=await import("mysql2/promise");const c=await m.default.createConnection({uri:process.env.DATABASE_URL});const [r]=await c.query("select houseId, room, count(*) n, sum(roomId is null) unlinked, group_concat(distinct floor) floors from items where room is not null group by 1,2 order by 1,2");console.table(r);await c.end()})'
```

Expected: the 8 known tuples (Begane grond, Floor 0, WC, Washok, Zolderkamer, Eetkamer, Keuken, Woonkamer); the ones with `unlinked > 0` (Washok 4, Zolderkamer 32, Keuken 5, Eetkamer 1, Woonkamer 1) are what step 2 of the backfill will link. Washok and Keuken get new rooms; the rest match existing scanned rooms by name. Do **not** run the backfill on production in this task; that is Task 10.

- [ ] **Step 6: Commit**

```bash
git add api/lib/backfillRooms.ts scripts/backfill-rooms.mjs package.json api/test/backfillRooms.test.ts
git commit -m "Add idempotent backfill that turns location strings into rooms"
```

---

### Task 4: Location library and the consolidated rooms router

**Files:**
- Create: `api/lib/location.ts`
- Modify: `api/routers/rooms.ts` (replace `listAll`, `listByHouse`, `unlinkedLocations`, `update`; add `list`, `ensure`, `create`, `merge`; keep `get`, `upsertFromScan`, `remove`, `cutFromRoom`)
- Modify: `api/routers/houses.ts:21-42` (delete `rooms`), `api/routers/map.ts:14-37,149-185` (delete `listLocations`, `renameLocation`)
- Test: `api/test/location.test.ts`, `api/test/rooms.test.ts`

**Interfaces:**
- Produces (`api/lib/location.ts`):
  - `ensureRoom(db, { houseId: number; name: string; floor?: string | null }): Promise<{ id: number; created: boolean }>`
  - `setItemLocation(db, itemId: number, loc: { roomId: number } | { roomId: null; houseId: number | null }): Promise<void>`
  - `roomSummary(db, roomIds: number[]): Promise<Map<number, { id: number; name: string; floor: string | null; houseId: number; hasGeometry: boolean }>>`
- Produces (router): `rooms.list({ houseId?: number | null })` → `{ id, houseId, name, floor, hasGeometry, parentRoomId, itemCount }[]` sorted by floor then name, defaulting to `ctx.houseId`, `null` = all houses; `rooms.ensure({ name, floor?, houseId? })` (houseId defaults to ctx); `rooms.create` (same input, throws on duplicate); `rooms.update({ id, name?, floor?, lat?, lng? })`; `rooms.merge({ fromId, toId })`; `rooms.remove({ id, force?: boolean })`.

- [ ] **Step 1: Write the failing tests**

```typescript
// api/test/location.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { ensureRoom, setItemLocation } from "../lib/location";

beforeEach(async () => {
  await resetTestDb();
});

describe("ensureRoom", () => {
  it("creates once and then finds, ignoring case and surrounding whitespace", async () => {
    const db = getTestDb();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "H" }).$returningId();
    const a = await ensureRoom(db, { houseId, name: "Keuken", floor: "ground" });
    const b = await ensureRoom(db, { houseId, name: "  keuken " });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });
  it("refuses an empty name", async () => {
    const db = getTestDb();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "H" }).$returningId();
    await expect(ensureRoom(db, { houseId, name: "   " })).rejects.toThrow(/name/);
  });
});

describe("setItemLocation", () => {
  it("putting an item in a room sets houseId to the room's house, even across houses", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp", houseId: h1 }).$returningId();
    const room = await ensureRoom(db, { houseId: h2, name: "Hal" });

    await setItemLocation(db, itemId, { roomId: room.id });
    const [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect(it.roomId).toBe(room.id);
    expect(it.houseId).toBe(h2);
  });
  it("unplacing keeps the house; clearing the house clears both", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const room = await ensureRoom(db, { houseId: h1, name: "Hal" });
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp", roomId: room.id, houseId: h1 }).$returningId();

    await setItemLocation(db, itemId, { roomId: null, houseId: h1 });
    let [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect([it.roomId, it.houseId]).toEqual([null, h1]);

    await setItemLocation(db, itemId, { roomId: null, houseId: null });
    [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect([it.roomId, it.houseId]).toEqual([null, null]);
  });
  it("rejects a room id that does not exist", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp" }).$returningId();
    await expect(setItemLocation(db, itemId, { roomId: 999 })).rejects.toThrow(/room/i);
  });
});
```

```typescript
// api/test/rooms.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./areas.test";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: zolder }] = await db.insert(rooms).values({ houseId: h1, name: "Zolder", floor: "attic", source: "manual" }).$returningId();
  const [{ id: hal }] = await db.insert(rooms).values({ houseId: h2, name: "Hal", source: "manual" }).$returningId();
  await db.insert(items).values([
    { areaId, name: "pan", houseId: h1, roomId: keuken },
    { areaId, name: "pot", houseId: h1, roomId: keuken },
    { areaId, name: "box", houseId: h1, roomId: zolder },
    { areaId, name: "coat", houseId: h2, roomId: hal },
  ]);
  return { db, h1, h2, areaId, keuken, zolder, hal };
}

describe("rooms.list", () => {
  it("defaults to the context house, sorted by floor then name, with counts and geometry flag", async () => {
    const { h1 } = await seed();
    const rows = await callerFor(h1).rooms.list();
    expect(rows.map((r) => [r.name, r.floor, r.itemCount, r.hasGeometry])).toEqual([
      ["Zolder", "attic", 1, false],
      ["Keuken", "ground", 2, false],
    ]);
  });
  it("returns every house's rooms with no context and no input", async () => {
    await seed();
    expect(await callerFor(null).rooms.list()).toHaveLength(3);
  });
  it("explicit houseId beats the context", async () => {
    const { h1, h2 } = await seed();
    expect((await callerFor(h1).rooms.list({ houseId: h2 })).map((r) => r.name)).toEqual(["Hal"]);
  });
});

describe("rooms.ensure / create", () => {
  it("ensure returns the existing room for a case-variant name", async () => {
    const { h1, keuken } = await seed();
    const r = await callerFor(h1).rooms.ensure({ name: "keuken" });
    expect(r).toEqual({ id: keuken, created: false });
  });
  it("create refuses a duplicate with a readable message", async () => {
    const { h1 } = await seed();
    await expect(callerFor(h1).rooms.create({ name: "Keuken" })).rejects.toThrow(/already exists/);
  });
  it("ensure without a house anywhere is an error", async () => {
    await seed();
    await expect(callerFor(null).rooms.ensure({ name: "Nieuw" })).rejects.toThrow(/house/i);
  });
});

describe("rooms.update", () => {
  it("renaming a room moves nothing and logs an event; floor can be cleared", async () => {
    const { db, h1, keuken } = await seed();
    await callerFor(h1).rooms.update({ id: keuken, name: "Kitchen", floor: null });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, keuken));
    expect([room.name, room.floor]).toEqual(["Kitchen", null]);
    const inRoom = await db.select().from(items).where(eq(items.roomId, keuken));
    expect(inRoom).toHaveLength(2);
  });
});

describe("rooms.merge", () => {
  it("moves items and location photos, then deletes the source", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.insert(attachments).values({ kind: "image", roomId: zolder, title: "photo" });
    const r = await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    expect(r).toEqual({ ok: true, itemsMoved: 1, photosMoved: 1 });
    expect(await db.select().from(rooms)).toHaveLength(2);
    expect(await db.select().from(items).where(eq(items.roomId, keuken))).toHaveLength(3);
  });
  it("refuses when both rooms carry geometry", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, keuken));
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, zolder));
    await expect(callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken })).rejects.toThrow(/geometry/);
  });
  it("carries geometry over when only the source has it", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.update(rooms).set({ walls: [{ points: [[0, 0], [1, 0]] }], widthM: 1, depthM: 1 }).where(eq(rooms.id, zolder));
    await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, keuken));
    expect(room.walls).toHaveLength(1);
    expect(room.widthM).toBe(1);
  });
  it("refuses to merge across houses", async () => {
    const { h1, keuken, hal } = await seed();
    await expect(callerFor(h1).rooms.merge({ fromId: hal, toId: keuken })).rejects.toThrow(/same house/);
  });
});

describe("rooms.remove", () => {
  it("refuses a room with items unless forced, and forced items stay in the house unplaced", async () => {
    const { db, h1, keuken } = await seed();
    await expect(callerFor(h1).rooms.remove({ id: keuken })).rejects.toThrow(/2 item/);
    await callerFor(h1).rooms.remove({ id: keuken, force: true });
    const rows = await db.select().from(items).where(eq(items.houseId, h1));
    expect(rows.filter((r) => r.roomId == null)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/location.test.ts api/test/rooms.test.ts`
Expected: FAIL — module `../lib/location` missing; `rooms.list` / `ensure` / `merge` not on the router.

- [ ] **Step 3: Implement `api/lib/location.ts`**

```typescript
// api/lib/location.ts
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { items, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";
import type { DbLike } from "./events";

type Db = ReturnType<typeof getDb>;
/** root db or a transaction handle: anything with the query builders we use */
export type LocDb = Pick<Db, "select" | "insert" | "update" | "query"> & DbLike;

/** Find-or-create a room in a house by name, case- and whitespace-insensitively. */
export async function ensureRoom(
  db: LocDb,
  input: { houseId: number; name: string; floor?: string | null },
): Promise<{ id: number; created: boolean }> {
  const name = input.name.trim();
  if (!name) throw new Error("A room needs a name.");
  const existing = await db
    .select({ id: rooms.id, floor: rooms.floor })
    .from(rooms)
    .where(and(eq(rooms.houseId, input.houseId), sql`lower(${rooms.name}) = ${name.toLowerCase()}`))
    .limit(1);
  if (existing[0]) {
    if (!existing[0].floor && input.floor) {
      await db.update(rooms).set({ floor: input.floor }).where(eq(rooms.id, existing[0].id));
    }
    return { id: existing[0].id, created: false };
  }
  const [{ id }] = await db
    .insert(rooms)
    .values({ houseId: input.houseId, name, floor: input.floor || null, source: "manual" })
    .$returningId();
  return { id, created: true };
}

/**
 * The only writer of items.roomId / items.houseId. Keeps the invariant:
 * in a room => houseId is that room's house; no room => houseId as given.
 */
export async function setItemLocation(
  db: LocDb,
  itemId: number,
  loc: { roomId: number } | { roomId: null; houseId: number | null },
): Promise<void> {
  if (loc.roomId != null) {
    const [room] = await db.select({ houseId: rooms.houseId }).from(rooms).where(eq(rooms.id, loc.roomId)).limit(1);
    if (!room) throw new Error(`Room #${loc.roomId} does not exist.`);
    await db.update(items).set({ roomId: loc.roomId, houseId: room.houseId }).where(eq(items.id, itemId));
    return;
  }
  await db.update(items).set({ roomId: null, houseId: loc.houseId }).where(eq(items.id, itemId));
}

export interface RoomSummary {
  id: number;
  name: string;
  floor: string | null;
  houseId: number;
  hasGeometry: boolean;
}

/** Small lookup used by list endpoints to attach room info to rows. */
export async function roomSummary(db: LocDb, roomIds: number[]): Promise<Map<number, RoomSummary>> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: rooms.id, name: rooms.name, floor: rooms.floor, houseId: rooms.houseId, hasGeometry: isNotNull(rooms.walls) })
    .from(rooms)
    .where(inArray(rooms.id, ids));
  return new Map(rows.map((r) => [r.id, { ...r, hasGeometry: !!r.hasGeometry }]));
}
```

- [ ] **Step 4: Rewrite the rooms router's list/CRUD surface**

In `api/routers/rooms.ts` delete `listAll` (lines 113-116), `listByHouse` (118-133), `unlinkedLocations` (288-311) and the existing `update` (205-220), and add these procedures (imports: `sql`, `inArray`, `isNotNull`, `desc` from drizzle-orm; `attachments` from schema; `ensureRoom`, `setItemLocation` from `../lib/location`; `TRPCError` from `@trpc/server`):

```typescript
  /** Every room of a house (default: the context house; null = all houses). */
  list: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      const db = getDb();
      const rows = await db
        .select({
          id: rooms.id,
          houseId: rooms.houseId,
          name: rooms.name,
          floor: rooms.floor,
          parentRoomId: rooms.parentRoomId,
          hasGeometry: isNotNull(rooms.walls),
          itemCount: sql<number>`(select count(*) from ${items} where ${items.roomId} = ${rooms.id} and ${items.status} = 'active')`,
        })
        .from(rooms)
        .where(houseId != null ? eq(rooms.houseId, houseId) : undefined);
      return rows
        .map((r) => ({ ...r, hasGeometry: !!r.hasGeometry, itemCount: Number(r.itemCount) }))
        .sort((a, b) => (a.floor ?? "").localeCompare(b.floor ?? "") || a.name.localeCompare(b.name));
    }),

  /** Find-or-create by name in a house (the picker's "create room …" row). */
  ensure: procedure
    .input(z.object({ name: z.string().min(1), floor: z.string().nullable().optional(), houseId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a house first." });
      const r = await ensureRoom(getDb(), { houseId, name: input.name, floor: input.floor });
      if (r.created) {
        await logEvent({ entityType: "room", entityId: r.id, action: "created", summary: `Room "${input.name.trim()}" added` });
      }
      return r;
    }),

  /** Strict create: a second room with the same name in one house is an error. */
  create: procedure
    .input(z.object({ name: z.string().min(1), floor: z.string().nullable().optional(), houseId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a house first." });
      const r = await ensureRoom(getDb(), { houseId, name: input.name, floor: input.floor });
      if (!r.created) throw new TRPCError({ code: "CONFLICT", message: `A room called "${input.name.trim()}" already exists in this house.` });
      await logEvent({ entityType: "room", entityId: r.id, action: "created", summary: `Room "${input.name.trim()}" added` });
      return { id: r.id };
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        floor: z.string().nullable().optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...rest } = input;
      const before = await db.query.rooms.findFirst({ where: eq(rooms.id, id) });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = k === "name" ? String(v).trim() : v;
      try {
        await db.update(rooms).set(patch).where(eq(rooms.id, id));
      } catch (err) {
        if (String((err as Error).message).includes("Duplicate entry")) {
          throw new TRPCError({ code: "CONFLICT", message: `A room called "${patch.name}" already exists in this house.` });
        }
        throw err;
      }
      const parts: string[] = [];
      if (patch.name !== undefined && patch.name !== before.name) parts.push(`renamed from "${before.name}" to "${patch.name}"`);
      if (patch.floor !== undefined && patch.floor !== before.floor) parts.push(`floor set to ${patch.floor ?? "none"}`);
      if (patch.lat !== undefined || patch.lng !== undefined) parts.push("position updated");
      await logEvent({
        entityType: "room",
        entityId: id,
        action: "updated",
        summary: parts.length ? `Room "${before.name}" ${parts.join(", ")}` : `Room "${before.name}" updated (no changes)`,
        payload: patch,
      });
      return { ok: true };
    }),

  /**
   * Fold one room into another (the old "rename location to merge" flow).
   * Items and location photos move; geometry moves only if the target has
   * none; two scanned rooms cannot be merged.
   */
  merge: procedure
    .input(z.object({ fromId: z.number(), toId: z.number() }))
    .mutation(async ({ input }) => {
      if (input.fromId === input.toId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a different room to merge into." });
      const db = getDb();
      const from = await db.query.rooms.findFirst({ where: eq(rooms.id, input.fromId) });
      const to = await db.query.rooms.findFirst({ where: eq(rooms.id, input.toId) });
      if (!from || !to) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      if (from.houseId !== to.houseId) throw new TRPCError({ code: "BAD_REQUEST", message: "Rooms must be in the same house to merge." });
      if (from.walls && to.walls) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Both rooms have scanned geometry; merging would drop one scan. Delete or cut rooms on the plan instead." });
      }
      return db.transaction(async (tx) => {
        const movedItems = await tx.select({ id: items.id }).from(items).where(eq(items.roomId, from.id));
        for (const it of movedItems) await setItemLocation(tx, it.id, { roomId: to.id });
        const movedPhotos = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.roomId, from.id));
        if (movedPhotos.length) await tx.update(attachments).set({ roomId: to.id }).where(eq(attachments.roomId, from.id));
        await tx.update(rooms).set({ parentRoomId: to.id }).where(eq(rooms.parentRoomId, from.id));
        if (from.walls && !to.walls) {
          await tx
            .update(rooms)
            .set({
              walls: from.walls,
              openings: from.openings,
              widthM: from.widthM,
              depthM: from.depthM,
              wallHeightM: from.wallHeightM,
              source: from.source,
              scanDate: from.scanDate,
              floor: to.floor ?? from.floor,
            })
            .where(eq(rooms.id, to.id));
        } else if (!to.floor && from.floor) {
          await tx.update(rooms).set({ floor: from.floor }).where(eq(rooms.id, to.id));
        }
        await tx.delete(rooms).where(eq(rooms.id, from.id));
        await logEvent(
          {
            entityType: "room",
            entityId: to.id,
            action: "merged",
            summary: `Room "${from.name}" merged into "${to.name}" (${movedItems.length} item(s), ${movedPhotos.length} photo(s))`,
          },
          tx,
        );
        return { ok: true as const, itemsMoved: movedItems.length, photosMoved: movedPhotos.length };
      });
    }),
```

Replace the existing `remove` with a version that refuses non-empty rooms unless forced (cut rooms keep their un-cut behaviour):

```typescript
  remove: procedure
    .input(z.object({ id: z.number(), force: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const room = await db.query.rooms.findFirst({ where: eq(rooms.id, input.id) });
      if (!room) return { ok: true, moved: 0 };
      const roomItems = await db.select().from(items).where(eq(items.roomId, input.id));

      if (room.parentRoomId != null) {
        // un-cut: items go back to the parent in the parent's frame
        const ox = room.offsetXM ?? 0, oy = room.offsetYM ?? 0;
        const parentId = room.parentRoomId;
        await db.transaction(async (tx) => {
          for (const it of roomItems) {
            const p = it.pos as ItemPos | null;
            await tx
              .update(items)
              .set({ roomId: parentId, pos: p ? { ...p, xM: +(p.xM + ox).toFixed(2), yM: +(p.yM + oy).toFixed(2) } : p })
              .where(eq(items.id, it.id));
          }
          await tx.update(attachments).set({ roomId: parentId }).where(eq(attachments.roomId, input.id));
          await tx.delete(rooms).where(eq(rooms.id, input.id));
          await logEvent(
            { entityType: "room", entityId: input.id, action: "deleted", summary: `Room "${room.name}" deleted, ${roomItems.length} item(s) moved back to parent room #${parentId}` },
            tx,
          );
        });
        return { ok: true, moved: roomItems.length };
      }

      if (roomItems.length > 0 && !input.force) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `"${room.name}" still holds ${roomItems.length} item(s). Merge it into another room, or delete anyway to leave them unplaced in the house.`,
        });
      }
      await db.transaction(async (tx) => {
        for (const it of roomItems) await setItemLocation(tx, it.id, { roomId: null, houseId: room.houseId });
        await tx.update(attachments).set({ roomId: null }).where(eq(attachments.roomId, input.id));
        await tx.update(rooms).set({ parentRoomId: null }).where(eq(rooms.parentRoomId, input.id));
        await tx.delete(rooms).where(eq(rooms.id, input.id));
        await logEvent(
          { entityType: "room", entityId: input.id, action: "deleted", summary: `Room "${room.name}" deleted (${roomItems.length} item(s) left unplaced)` },
          tx,
        );
      });
      return { ok: true, moved: roomItems.length };
    }),
```

In `cutFromRoom`, where the new room is inserted, add `floor: source.floor,` to the values, and replace the two item updates so they go through the invariant: the per-item `tx.update(items).set({ roomId: newRoomId, room: input.name, pos: ... })` becomes `tx.update(items).set({ roomId: newRoomId, houseId: source.houseId, pos: ... })`, and delete the trailing "string-linking" update (`.where(and(eq(items.houseId, source.houseId), eq(items.room, input.name), isNull(items.roomId)))`) entirely: after the backfill there are no string-only items. In `upsertFromScan`, add `floor: z.string().nullable().optional()` to the input and `floor: input.floor ?? undefined` to `values` (an undefined floor leaves an existing one alone on update).

Delete `houses.rooms` (`api/routers/houses.ts:21-42`). Delete `map.listLocations` (`map.ts:14-37`) and `map.renameLocation` (`map.ts:149-185`); clean the now-unused imports. (The remaining `map.photosForLocation` and `ensureAttachmentForCapture` change in Task 5.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run api/test/location.test.ts api/test/rooms.test.ts`
Expected: PASS — 5 + 12 tests.

- [ ] **Step 6: Type-check and commit**

Run: `npm run check` — expect errors only in frontend files that call the removed procedures (`houses.rooms`, `map.listLocations`, `map.renameLocation`, `rooms.listByHouse`, `rooms.listAll`, `rooms.unlinkedLocations`). Those are fixed in Tasks 6–8; record the file list in the commit message. `npx eslint api` must be clean.

```bash
git add api/lib/location.ts api/routers/rooms.ts api/routers/houses.ts api/routers/map.ts api/test/location.test.ts api/test/rooms.test.ts
git commit -m "Consolidate the rooms API: list/ensure/create/update/merge/remove, location invariant helpers

Frontend callers of houses.rooms, map.listLocations, map.renameLocation,
rooms.listByHouse, rooms.listAll and rooms.unlinkedLocations are updated
in the next commits."
```

---

### Task 5: Items, inbox, photos and attachments speak roomId

**Files:**
- Modify: `api/routers/items.ts:52-75` (listAll), `:77-100` (get), `:152-195` (create), `:285-350` (update)
- Modify: `api/routers/inbox.ts:58-65,102-130` (triage suggestion), `:438-520` (fileObject), `:525-600` (acceptMany), `:622-710` (importGeojson)
- Modify: `api/routers/map.ts` (`photosForLocation`, `ensureAttachmentForCapture`), `api/routers/attachments.ts:95-120` (unlink), `:285-355` (listAllImages)
- Modify: `db/schema.ts:243-250` (`TriageSuggestion` gains `roomId`)
- Test: `api/test/items-location.test.ts`, `api/test/inbox-location.test.ts`

**Interfaces:**
- `items.listAll({ includeArchived?, houseId?: number | null, roomId?: number })` → rows gain `room: { id, name, floor } | null`; `houseId` defaults to ctx (null = all).
- `items.get` → gains `room: RoomSummary | null`.
- `items.create({ …, roomId?: number | null, houseId?: number | null })`, `items.update({ …, roomId?: number | null, houseId?: number | null })`; `floor`/`room` inputs removed.
- `inbox.acceptMany({ id, roomId?: number | null, houseId?: number | null, items })`, `inbox.fileObject({ …, roomId?: number | null, houseId?: number | null })`, `inbox.importGeojson({ captureId, roomId?: number, roomName?: string, houseId? })` (existing room by id, or create by name in the context house).
- `TriageSuggestion.roomId?: number | null` resolved server-side from `room` text within the context house.
- `map.photosForLocation({ roomId })`, `map.ensureAttachmentForCapture({ captureId, roomId?: number | null })`, `attachments.listAllImages` rows gain `roomId`, `roomName`, `floor`, `houseId` from the room.

- [ ] **Step 1: Write the failing tests**

```typescript
// api/test/items-location.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./areas.test";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: hal }] = await db.insert(rooms).values({ houseId: h2, name: "Hal", source: "manual" }).$returningId();
  return { db, h1, h2, areaId, keuken, hal };
}

describe("items.create / update location", () => {
  it("create with roomId derives houseId; update to another house's room follows it", async () => {
    const { db, h1, h2, areaId, keuken, hal } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    let [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([keuken, h1]);

    await callerFor(h1).items.update({ id, roomId: hal });
    [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([hal, h2]);
  });
  it("create without a room lands unplaced in the context house", async () => {
    const { db, h1, areaId } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "lamp" });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([null, h1]);
  });
});

describe("items.listAll / get", () => {
  it("lists the context house by default, joins the room, and filters by roomId", async () => {
    const { h1, areaId, keuken, hal } = await seed();
    await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    await callerFor(h1).items.create({ areaId, name: "coat", roomId: hal });
    await callerFor(h1).items.create({ areaId, name: "lamp" });

    const mine = await callerFor(h1).items.listAll({});
    expect(mine.map((r) => [r.name, r.room?.name ?? null, r.room?.floor ?? null]).sort()).toEqual([
      ["lamp", null, null],
      ["pan", "Keuken", "ground"],
    ]);
    expect((await callerFor(h1).items.listAll({ roomId: keuken })).map((r) => r.name)).toEqual(["pan"]);
    expect(await callerFor(h1).items.listAll({ houseId: null })).toHaveLength(3);

    const one = await callerFor(h1).items.get({ id: mine.find((r) => r.name === "pan")!.id });
    expect(one?.room).toMatchObject({ id: keuken, name: "Keuken", floor: "ground", hasGeometry: false });
  });
});
```

```typescript
// api/test/inbox-location.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, captures, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./areas.test";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "a pan and a pot" }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

describe("inbox.acceptMany", () => {
  it("files new items into the given room with the room's house", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "pan" },
        { areaId, itemId: null, itemName: "pot" },
      ],
    });
    const rows = await db.select().from(items);
    expect(rows.map((r) => [r.roomId, r.houseId])).toEqual([[keuken, h1], [keuken, h1]]);
  });
  it("without a room, new items are unplaced in the context house", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan" }] });
    const [row] = await db.select().from(items);
    expect([row.roomId, row.houseId]).toEqual([null, h1]);
  });
});

describe("map.ensureAttachmentForCapture", () => {
  it("creates a location photo linked by roomId", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/does-not-matter.jpg" }).$returningId();
    // the copy step needs a real file; stub it by writing one into uploads/
    const fs = await import("fs");
    fs.mkdirSync("uploads", { recursive: true });
    fs.writeFileSync("uploads/does-not-matter.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = await callerFor(h1).map.ensureAttachmentForCapture({ captureId: capId, roomId: keuken });
    const [att] = await db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
    expect(att.roomId).toBe(keuken);
    expect(att.itemId).toBeNull();
    fs.rmSync(att.storageKey!.replace(/^local\//, "uploads/"), { force: true });
    fs.rmSync("uploads/does-not-matter.jpg", { force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/items-location.test.ts api/test/inbox-location.test.ts`
Expected: FAIL — zod rejects `roomId`-only inputs / `room` missing on rows / `ensureAttachmentForCapture` input shape.

- [ ] **Step 3: items router**

`listAll`:

```typescript
  listAll: procedure
    .input(
      z.object({
        includeArchived: z.boolean().default(false),
        houseId: z.number().nullable().optional(),
        roomId: z.number().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const houseId = input.houseId !== undefined ? input.houseId : ctx.houseId;
      const db = getDb();
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            input.includeArchived ? undefined : eq(items.status, "active"),
            houseId != null ? eq(items.houseId, houseId) : undefined,
            input.roomId != null ? eq(items.roomId, input.roomId) : undefined,
          ),
        )
        .orderBy(desc(items.updatedAt));
      const allAreas = await db.select().from(areas);
      const areaById = new Map(allAreas.map((a) => [a.id, a]));
      const roomsById = await roomSummary(db, rows.map((r) => r.roomId).filter((x): x is number => x != null));
      const ids = rows.map((r) => r.id);
      const atts = ids.length
        ? await db.select().from(attachments).where(and(eq(attachments.kind, "image"), inArray(attachments.itemId, ids)))
        : [];
      const imgMap = new Map<number, string>();
      for (const a of atts) if (a.itemId && a.storageKey && !imgMap.has(a.itemId)) imgMap.set(a.itemId, a.storageKey);
      return rows.map((r) => ({
        ...r,
        imageKey: imgMap.get(r.id) ?? null,
        areaName: areaById.get(r.areaId)?.name ?? null,
        areaSlug: areaById.get(r.areaId)?.slug ?? null,
        room: r.roomId != null ? (roomsById.get(r.roomId) ?? null) : null,
      }));
    }),
```

`get`: after the `house` lookup add

```typescript
    const room = item.roomId != null ? ((await roomSummary(db, [item.roomId])).get(item.roomId) ?? null) : null;
```

and include `room` in the returned object next to `house`.

`create`: replace the `houseId`/`roomId`/`floor`/`room` input lines with

```typescript
        roomId: z.number().nullable().optional(),
        houseId: z.number().nullable().optional(),
```

and after the insert (which no longer sets `floor`/`room`; insert `houseId: input.houseId ?? ctx.houseId ?? null, roomId: null`), call

```typescript
      if (input.roomId != null) await setItemLocation(db, id, { roomId: input.roomId });
```

(the procedure handler gains `ctx` in its destructuring). `update`: remove `floor` and `room` from the input; pull `roomId` and `houseId` out of `rest` before building `patch`:

```typescript
      const { id, attributes, pos, roomId, houseId, ...rest } = input;
      // ...existing patch building for rest/attributes/pos...
      const before = await db.query.items.findFirst({ where: eq(items.id, id) });
      if (Object.keys(patch).length) await db.update(items).set(patch).where(eq(items.id, id));
      if (roomId !== undefined || houseId !== undefined) {
        if (roomId != null) await setItemLocation(db, id, { roomId });
        else await setItemLocation(db, id, { roomId: null, houseId: houseId !== undefined ? houseId : (before?.houseId ?? null) });
      }
```

In the history summary replace the `floor`/`room`/`houseId`/`roomId` branches with one:

```typescript
      if (roomId !== undefined || houseId !== undefined) {
        const after = await db.query.items.findFirst({ where: eq(items.id, id) });
        const label = after?.roomId != null ? ((await roomSummary(db, [after.roomId])).get(after.roomId)?.name ?? `room #${after.roomId}`) : after?.houseId != null ? "unplaced in house" : "none";
        if (after?.roomId !== before?.roomId || after?.houseId !== before?.houseId) parts.push(`location set to ${label}`);
      }
```

Imports: `roomSummary`, `setItemLocation` from `../lib/location`; `inArray` from drizzle-orm.

- [ ] **Step 4: inbox router**

`TriageSuggestion` in `db/schema.ts` gains `roomId?: number | null;` with the comment `// resolved from \`room\` text within the session's house; null = no such room yet`. In `resolveSuggestion` (inbox.ts:106) add a `houseId: number | null` parameter, and after `floor`/`room` are settled:

```typescript
  let roomId: number | null = null;
  if (room && houseId != null) {
    const [hit] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.houseId, houseId), sql`lower(${rooms.name}) = ${room.trim().toLowerCase()}`))
      .limit(1);
    roomId = hit?.id ?? null;
  } else if (!room) {
    const withRoom = matched.find((i) => i.roomId != null);
    roomId = withRoom?.roomId ?? null;
  }
  return { note: object.note, floor, room, roomId, items: … };
```

Both call sites (`triage` and `compare`) pass `ctx.houseId`.

`fileObject`: input loses `floor`/`room`, gains `roomId: z.number().nullable().optional()`; keep `houseId`. The new-item insert sets `houseId: input.houseId ?? ctx.houseId ?? null` and no `floor`/`room`; after the insert: `if (input.roomId != null) await setItemLocation(db, itemId, { roomId: input.roomId });`.

`acceptMany`: same input change; wrap the whole loop in `db.transaction(async (tx) => …)` (every `db.` inside becomes `tx.`, `logEvent(…, tx)`), the new-item insert sets `houseId: input.houseId ?? ctx.houseId ?? null`, then `if (input.roomId != null) await setItemLocation(tx, itemId, { roomId: input.roomId });`.

`importGeojson`: input becomes `z.object({ captureId: z.number(), roomId: z.number().optional(), roomName: z.string().min(1).optional(), houseId: z.number().optional() })` with a refine that one of `roomId`/`roomName` is present. Resolve the target first:

```typescript
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null && input.roomId == null) throw new Error("Pick a house first.");
      const target = input.roomId != null
        ? await db.query.rooms.findFirst({ where: eq(rooms.id, input.roomId) })
        : null;
      if (input.roomId != null && !target) throw new Error("Room not found.");
      const targetHouseId = target?.houseId ?? houseId!;
      const match = target ?? (await db.query.rooms.findFirst({
        where: and(eq(rooms.houseId, targetHouseId), sql`lower(${rooms.name}) = ${input.roomName!.trim().toLowerCase()}`),
      }));
      const roomName = target?.name ?? input.roomName!.trim();
```

then use `targetHouseId`/`roomName`/`match` where the old code used `input.houseId`/`input.roomName`; the detected item inserts drop `room: input.roomName` and keep `houseId: targetHouseId, roomId`.

- [ ] **Step 5: map and attachments**

`map.photosForLocation`: input `z.object({ roomId: z.number() })`; the item filter becomes `and(eq(items.status, "active"), eq(items.roomId, input.roomId))`. `map.ensureAttachmentForCapture`: input `z.object({ captureId: z.number(), roomId: z.number().nullable().optional() })`; the "existing" branch sets `roomId` when `input.roomId != null && existing.roomId == null`; the insert sets `roomId: input.roomId ?? null` and no `houseId`/`floor`/`room`.

`attachments.unlink`: the `set` becomes `{ itemId: null, roomId: att.roomId ?? item?.roomId ?? null }`. `attachments.listAllImages`: after `itemById`, compute `const roomsById = await roomSummary(db, [...allItems.map((i) => i.roomId), ...atts.map((a) => a.roomId)].filter((x): x is number => x != null))`; each attachment row gets

```typescript
        roomId: it?.roomId ?? a.roomId ?? null,
        roomName: roomsById.get(it?.roomId ?? a.roomId ?? -1)?.name ?? null,
        floor: roomsById.get(it?.roomId ?? a.roomId ?? -1)?.floor ?? null,
        houseId: roomsById.get(it?.roomId ?? a.roomId ?? -1)?.houseId ?? it?.houseId ?? null,
```

instead of `houseId/floor/room`; capture rows get `roomId: null, roomName: null, floor: null, houseId: null`. The pin-confirm path in `attachments.createCutoutFromAttachment` (`:340-350`) that sets `houseId: null, floor: null` on the cutout drops those keys.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run api/test`
Expected: PASS — every test file so far (areas, rooms-schema, backfillRooms, location, rooms, items-location, inbox-location, db, db.smoke).

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts api/routers/items.ts api/routers/inbox.ts api/routers/map.ts api/routers/attachments.ts api/test/items-location.test.ts api/test/inbox-location.test.ts
git commit -m "Items, inbox, photos and attachments locate by roomId; triage resolves the room in the session house"
```

---

### Task 6: Workbench front end, part A — picker, inbox, item page, annotate

**Files:**
- Rewrite: `src/components/RoomPicker.tsx`
- Create: `src/lib/lastRoom.ts`; Delete: `src/lib/lastLocation.ts`
- Modify: `src/components/DetectObjects.tsx:12-14,116-120,145-146,173-174,219-221,365`, `src/pages/Inbox.tsx` (all lines listed in the grep below), `src/pages/ItemDetail.tsx:9,172-175,260-282,733-750,794-814`, `src/pages/Annotate.tsx:145-153,456-458,464`, `src/components/ChooseFromLibraryDialog.tsx:80`

**Interfaces:**
- `RoomPicker` props: `{ value: number | null; onChange: (roomId: number | null) => void; houseId?: number; allowCreate?: boolean; allowNone?: boolean; autoFocus?: boolean }`. It reads `useHouse()` when `houseId` is omitted.
- `src/lib/lastRoom.ts`: `getLastRoomId(): number | null`, `setLastRoomId(id: number | null)`, key `declutter.lastRoomId`.

- [ ] **Step 1: The new picker**

```tsx
// src/components/RoomPicker.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useHouse } from "@/context/house";
import { cn } from "@/lib/utils";

export const DEFAULT_FLOORS = ["basement", "ground", "1", "2", "3", "attic"];

/**
 * Pick a room in the current house. Floor is shown on each room, never
 * asked for separately; only the "create room …" row offers a floor.
 */
export function RoomPicker({
  value,
  onChange,
  houseId: houseIdProp,
  allowCreate = true,
  allowNone = false,
  autoFocus = false,
}: {
  value: number | null;
  onChange: (roomId: number | null) => void;
  houseId?: number;
  allowCreate?: boolean;
  allowNone?: boolean;
  autoFocus?: boolean;
}) {
  const { houseId: ctxHouseId } = useHouse();
  const houseId = houseIdProp ?? ctxHouseId;
  const utils = trpc.useUtils();
  const rooms = trpc.rooms.list.useQuery({ houseId: houseId ?? null }, { enabled: houseId != null });
  const ensure = trpc.rooms.ensure.useMutation({
    onSuccess: (r) => {
      utils.rooms.list.invalidate();
      onChange(r.id);
      setOpen(false);
    },
  });

  const selected = rooms.data?.find((r) => r.id === value) ?? null;
  const [text, setText] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [newFloor, setNewFloor] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setText(selected?.name ?? ""), [selected?.name]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = text.trim().toLowerCase();
  const matches = useMemo(
    () => (rooms.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 12),
    [rooms.data, q],
  );
  const exact = (rooms.data ?? []).find((r) => r.name.toLowerCase() === q);
  const showCreate = allowCreate && q.length > 0 && !exact;
  const knownFloors = useMemo(() => {
    const f = [...new Set((rooms.data ?? []).map((r) => r.floor).filter((x): x is string => !!x))];
    return f.length ? f : DEFAULT_FLOORS;
  }, [rooms.data]);
  const rowCount = matches.length + (showCreate ? 1 : 0);
  useEffect(() => setHighlight(0), [q, rowCount]);

  const pick = (id: number) => {
    onChange(id);
    setOpen(false);
  };
  const create = () => {
    if (houseId == null || !text.trim()) return;
    ensure.mutate({ houseId, name: text.trim(), floor: newFloor || null });
  };
  const selectAt = (i: number) => {
    if (i < matches.length) pick(matches[i].id);
    else if (showCreate) create();
  };

  if (houseId == null) {
    return <div className="text-[12px] text-muted-foreground">Pick a house first.</div>;
  }

  return (
    <div className="relative" ref={wrapRef}>
      <input
        id="room-picker"
        autoFocus={autoFocus}
        className="w-full rounded border border-input bg-white px-2 py-1 pr-6 text-[12px]"
        placeholder="room…"
        value={text}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (e.target.value.trim() === "" && allowNone) onChange(null);
        }}
        onKeyDown={(e) => {
          if (!open || rowCount === 0) {
            if (e.key === "Escape") setOpen(false);
            return;
          }
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % rowCount); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + rowCount) % rowCount); }
          else if (e.key === "Enter") { e.preventDefault(); selectAt(highlight); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {!open && selected && <Check className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-emerald-600" />}
      {open && rowCount > 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-white shadow-lg max-h-56 overflow-auto">
          {matches.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className={cn("flex w-full items-center gap-2 px-2 py-1 text-left text-[12px]", i === highlight ? "bg-accent" : "hover:bg-accent")}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(r.id); }}
            >
              <span className="flex-1 truncate">{r.name}</span>
              {r.floor && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{r.floor}</span>}
              {r.hasGeometry && <span className="text-[10px] text-muted-foreground">plan</span>}
              {r.id === value && <Check className="h-3 w-3 text-primary" />}
            </button>
          ))}
          {showCreate && (
            <div
              className={cn("flex items-center gap-2 border-t border-border px-2 py-1 text-[11px]", highlight === matches.length ? "bg-primary/10" : "bg-primary/5")}
              onMouseEnter={() => setHighlight(matches.length)}
            >
              <button type="button" className="flex items-center gap-1 text-primary" onMouseDown={(e) => { e.preventDefault(); create(); }}>
                <Plus className="h-3 w-3" /> create "{text.trim()}"
              </button>
              <select
                id="room-picker-new-floor"
                aria-label="Floor of the new room"
                className="ml-auto rounded border border-input bg-white px-1 py-0.5 text-[11px]"
                value={newFloor}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setNewFloor(e.target.value)}
              >
                <option value="">no floor</option>
                {knownFloors.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      {ensure.isError && <div className="mt-1 text-[11px] text-destructive">{ensure.error.message}</div>}
    </div>
  );
}
```

```typescript
// src/lib/lastRoom.ts
const KEY = "declutter.lastRoomId";

/** The room you last filed something into: the default for the next "where?" */
export function getLastRoomId(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setLastRoomId(id: number | null) {
  try {
    if (id == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(id));
  } catch {
    // storage unavailable
  }
}
```

Delete `src/lib/lastLocation.ts`. Keep the `RoomValue` type nowhere; every consumer now holds `roomId: number | null`.

- [ ] **Step 2: DetectObjects**

- Line 12-14: import `RoomPicker` (no type), `getLastRoomId`/`setLastRoomId` from `@/lib/lastRoom`.
- Line 116-120: `const [roomId, setRoomId] = useState<number | null>(null);`
- Line 145-146 (initial default): `setRoomId(getLastRoomId());`
- Line 173-174 (existing item chosen): `if (item?.roomId != null) setRoomId(item.roomId);`
- Line 219-221 (`file()` call): replace `houseId/floor/room` with `roomId,` and after a successful file call `setLastRoomId(roomId)`.
- Line 365: `<RoomPicker value={roomId} onChange={setRoomId} allowNone />`.

- [ ] **Step 3: Inbox**

- Line 9-10: import `RoomPicker` and `lastRoom` helpers; drop `RoomValue`, `lastLocation`.
- `PinCaptureButton` (82-123) and `PinPendingButton` (210-290): state becomes `const [roomId, setRoomId] = useState<number | null>(() => getLastRoomId());`; `hasDefaultLocation` becomes `roomId != null`; `ensure.mutate({ captureId, roomId })`; the navigate query becomes `?roomId=${roomId ?? "none"}`; the dialog title at 258 shows the picker's current room name via `trpc.rooms.list` lookup: `const roomName = rooms.data?.find((r) => r.id === roomId)?.name ?? "unset"`; `<RoomPicker value={roomId} onChange={setRoomId} />`.
- `TriageCard` (395-723): the location state at 418 becomes `useState<number | null>(() => s?.roomId ?? getLastRoomId())`; the triage-result effect at 446 becomes `if (res.suggestion.roomId != null) setRoomId(res.suggestion.roomId)`; the compare "use this result" at 661 likewise; the `acceptMany` call at 702-707 passes `roomId` and calls `setLastRoomId(roomId)`; the picker at 692 is `<RoomPicker value={roomId} onChange={setRoomId} allowNone />`; the A/B display at 770 shows `side.suggestion.room` text only when `roomId` is null (`unknown room "…"`).
- Geojson import (425-440, 510-560): delete `allLocations`/`geoHouseId`/`geoRoomName` and the `<select>` of locations; replace with `const [geoRoomId, setGeoRoomId] = useState<number | null>(null)` and `<RoomPicker value={geoRoomId} onChange={setGeoRoomId} />` plus a hint "Pick the room this scan belongs to, or type a new name"; the mutation call becomes `importGeojson.mutate({ captureId: c.id, roomId: geoRoomId! })` with the button disabled until `geoRoomId != null`. Line 466 `utils.rooms.listByHouse.invalidate()` → `utils.rooms.list.invalidate()`.

- [ ] **Step 4: ItemDetail**

- Line 9: import `RoomPicker`; line 172-175: `const [roomId, setRoomId] = useState<number | null>(null);`
- Lines 260-273 (seed from item or an adjacent sibling): `if (it.roomId == null) { const adjacent = siblings.find((s) => s.roomId != null); setRoomId(adjacent?.roomId ?? null); } else setRoomId(it.roomId);` (keep the existing effect structure; only the fields change).
- `saveLoc` (275-282): `update.mutate({ id: itemId, roomId, houseId: roomId == null ? it.houseId : undefined })`.
- Display (733-750): replace the `it.floor || it.room` block with

```tsx
                {it.room ? (
                  <span className="text-[13px]">
                    <Link to={`/items?roomId=${it.room.id}`} className="hover:underline">{it.room.name}</Link>
                    {it.room.floor && <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">{it.room.floor}</span>}
                    {it.room.hasGeometry && <Link to={`/rooms/${it.room.id}`} className="ml-2 text-[11px] text-muted-foreground hover:underline">open plan</Link>}
                  </span>
                ) : it.house ? (
                  <span className="text-[13px] text-muted-foreground">Unplaced in {it.house.name}</span>
                ) : (
                  <span className="text-[13px] text-muted-foreground">No location</span>
                )}
                {editingLoc && <RoomPicker value={roomId} onChange={setRoomId} allowNone autoFocus />}
```

- Sub-object create (794-814): pass `roomId: it.roomId, houseId: it.houseId` instead of the three strings.

- [ ] **Step 5: Annotate and ChooseFromLibrary**

- `Annotate.tsx:145-153`: read `roomId` from the query string: `const roomIdParam = searchParams.get("roomId"); const confirmedRoomId = roomIdParam && roomIdParam !== "none" ? Number(roomIdParam) : null;`
- `:456-458` (new item from a pin): `roomId: confirmedRoomId ?? undefined,`; `:464`: `utils.rooms.list.invalidate()` instead of `map.listLocations`.
- `ChooseFromLibraryDialog.tsx:80`: `ensure.mutateAsync({ captureId })`.

- [ ] **Step 6: Verify**

Run: `npm run check` — expect remaining errors only in the files Task 7 and 8 own (Layout, Dashboard, AllItems, Photos, Map, Galaxy, Rooms, RoomPlan, Settings, FloorsEditor, HousesMap, flow/*). `npx eslint src/components/RoomPicker.tsx src/lib/lastRoom.ts src/components/DetectObjects.tsx src/pages/Inbox.tsx src/pages/ItemDetail.tsx src/pages/Annotate.tsx` clean.

Manual, on `npm run dev`: Inbox → triage a note → the room field is prefilled with the last room or the AI's room; typing "Bijkeuken" offers create with a floor select; accept files the items; Item page → edit location → pick a room → the page shows the room name with its floor badge.

- [ ] **Step 7: Commit**

```bash
git add -A src/components/RoomPicker.tsx src/lib/lastRoom.ts src/lib/lastLocation.ts src/components/DetectObjects.tsx src/pages/Inbox.tsx src/pages/ItemDetail.tsx src/pages/Annotate.tsx src/components/ChooseFromLibraryDialog.tsx
git commit -m "Workbench picks rooms by id: new RoomPicker, inbox/detect/item/annotate flows"
```

---

### Task 7: Workbench front end, part B — browse views, houses, rooms list

**Files:**
- Modify: `src/components/Layout.tsx:7,149-170,234-262,309-355`, `src/pages/Dashboard.tsx:14-16,283,338,355,381,411,428,483,502,522-547,616-650,660-670,703,758`, `src/pages/AllItems.tsx:13-70,222`, `src/pages/Photos.tsx:20,59,101-110`, `src/pages/Map.tsx` (whole list half), `src/pages/Galaxy.tsx:20,44,77-138,232-246,427`, `src/pages/Rooms.tsx` (rewrite), `src/pages/RoomPlan.tsx:89-91,121,382-395`, `src/pages/Settings.tsx:4-6,518,657,706,724,769-771`, `src/components/HousesMap.tsx:6,60-63`
- Delete: `src/components/FloorsEditor.tsx`

- [ ] **Step 1: Layout — Locations section becomes the house's rooms, grouped by floor; rename dialog becomes rename/merge room**

Replace the `locations` query and the section body:

```tsx
  const roomList = trpc.rooms.list.useQuery(); // context house
  const byFloor = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof roomList.data>>();
    for (const r of roomList.data ?? []) {
      const k = r.floor ?? "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return [...groups.entries()];
  }, [roomList.data]);
```

```tsx
        {!locationsCollapsed && (
          <nav className="px-2 space-y-0.5">
            {byFloor.map(([floor, list]) => (
              <div key={floor || "nofloor"}>
                {byFloor.length > 1 && <div className="px-2.5 pt-1 micro-label text-[#8a8e7a]">{floor || "no floor"}</div>}
                {list.map((r) => (
                  <NavLink key={r.id} to={`/items?roomId=${r.id}`} className={(a) => cn(navLinkClass(a), "group")} onClick={() => setMenuOpen(false)}>
                    <MapPin className="h-4 w-4 text-[#b4b8a5] shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{r.name}</span>
                    <span className="font-data text-[11px] opacity-60">{r.itemCount}</span>
                    <button className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-[#f4f4ed]" title="Rename or merge this room"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingRoom(r); setRenameTo(r.name); setMergeInto(null); }}>
                      <Pencil className="h-3 w-3" />
                    </button>
                  </NavLink>
                ))}
              </div>
            ))}
            {roomList.data?.length === 0 && <div className="px-2.5 py-1 text-[12px] text-[#8a8e7a]">No rooms yet</div>}
          </nav>
        )}
```

State and mutations: `const [editingRoom, setEditingRoom] = useState<{ id: number; name: string; floor: string | null } | null>(null); const [renameTo, setRenameTo] = useState(""); const [mergeInto, setMergeInto] = useState<number | null>(null);` with `trpc.rooms.update` and `trpc.rooms.merge` mutations that invalidate `rooms.list`, `items.listAll`, `items.get`. The dialog body:

```tsx
            <div className="space-y-3">
              <label className="block text-[12px]">Name
                <input id="room-rename" className="mt-1 w-full rounded border border-input px-2 py-1 text-[13px]" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
              </label>
              <label className="block text-[12px]">Floor
                <input id="room-floor" className="mt-1 w-full rounded border border-input px-2 py-1 text-[13px]" defaultValue={editingRoom.floor ?? ""} placeholder="e.g. ground, 1, attic" onBlur={(e) => updateRoom.mutate({ id: editingRoom.id, floor: e.target.value.trim() || null })} />
              </label>
              <div className="text-[12px]">Or merge into another room
                <RoomPicker value={mergeInto} onChange={setMergeInto} allowCreate={false} allowNone />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingRoom(null)}>Cancel</Button>
                {mergeInto != null && mergeInto !== editingRoom.id ? (
                  <Button size="sm" onClick={() => mergeRoom.mutate({ fromId: editingRoom.id, toId: mergeInto })}>Merge</Button>
                ) : (
                  <Button size="sm" disabled={!renameTo.trim()} onClick={() => updateRoom.mutate({ id: editingRoom.id, name: renameTo.trim() })}>Save</Button>
                )}
              </div>
              {(updateRoom.isError || mergeRoom.isError) && <div className="text-[12px] text-destructive">{updateRoom.error?.message ?? mergeRoom.error?.message}</div>}
            </div>
```

- [ ] **Step 2: Dashboard**

- Remove `getLastLocation`/`setLastLocation`/`FloorsEditor` imports. `houseId` state (660-670) comes from `useHouse()`; `selectHouse` becomes `setHouseId`. Remove the `floors` state and `<FloorsEditor>` from `AddHouseDialog` (283, 338, 355) and `EditHouseDialog` (411, 428, 483, 502) and the `floors` field from `HouseRowProps` (381); the `houses.create/update` calls drop `floors`.
- `LocationsSection` (616-650): query `trpc.rooms.list.useQuery()` (context house), render the top 8 rooms by `itemCount`, link `/items?roomId=${r.id}`, show `r.floor` as the secondary label; the `houseId` prop is no longer needed.

- [ ] **Step 3: AllItems**

Replace the `houseId/floor/room` search-param handling (13-50) with one `roomId` param:

```tsx
  const roomIdParam = searchParams.get("roomId");
  const roomFilter = roomIdParam && roomIdParam !== "none" ? Number(roomIdParam) : null;
  const clearRoom = () => { const next = new URLSearchParams(searchParams); next.delete("roomId"); setSearchParams(next, { replace: true }); };
  const itemsQuery = trpc.items.listAll.useQuery({ includeArchived: false, roomId: roomFilter ?? undefined });
```

Search (56-57) matches `i.room?.name` and `i.room?.floor`; the location group key (68) is `i.room ? i.room.name : "(no room)"` with floor as the group's sub-label; the row cell (222) renders `it.room?.name ?? "—"` plus a floor badge when present. The active-filter chip shows the room name from `trpc.rooms.list` and clears with `clearRoom`.

- [ ] **Step 4: Photos, Map, Galaxy, Rooms, RoomPlan, Settings, HousesMap**

- `Photos.tsx:20`: type field `roomId: number | null; roomName: string | null; floor: string | null;`; `:59`: `ensure.mutate({ captureId: photo.captureId! })`; `:101-110`: search on `roomName`/`floor`, group key `p.roomName ?? "(no room)"`.
- `Map.tsx`: `locations` → `trpc.rooms.list.useQuery({ houseId: null })` (all houses, this is the cross-house view); `Location` type becomes the row type; `locationKey` is `String(l.id)`; the list shows `l.name` with `[houseName, floor]` secondary (join to `houses.list` for the name); `photosForLocation` is called with `{ roomId: selected.id }`; `PhotoCard` passes `{ captureId, roomId: selected.id }` to `ensure`.
- `Galaxy.tsx`: `:20` import `useHouse` instead of `getLastLocation`; `:44` item type gains `room: { id: number; name: string; floor: string | null } | null`; grouping functions `:77-138` use `it.room?.floor?.trim() || "No floor"` and `it.room?.name?.trim() || "No room"`; `:232` house filter initial value `useHouse().houseId ?? "all"` and the items query passes `{ houseId: houseFilter === "all" ? null : houseFilter }` instead of filtering client-side at `:246`; `:427` label `it.room ? it.room.name : "no room"`.
- `Rooms.tsx`: rewrite to list `trpc.rooms.list.useQuery()` for the context house, grouped by floor, each row showing name, floor badge, item count and either "open plan" (`/rooms/:id`, when `hasGeometry`) or "no scan yet" with the row linking to `/items?roomId=`. The "Pick a house on the Dashboard first" message becomes `if (houseId == null) return <p>Add a house to get started.</p>` via `useHouse()`.
- `RoomPlan.tsx:89-91`: delete the `unlinkedLocations` query; `:382-395`: the cut-name field is a plain `<input>` (names are free; `cutFromRoom` creates the room); `:121` `createItem` passes `roomId: room.data.id` only (houseId derives).
- `Settings.tsx`: remove `DEFAULT_FLOORS`/`FloorsEditor` imports (4-6), the `floors` prop/state/editor (518, 657, 706, 724), and replace the floors line (769-771) with the room count from `trpc.rooms.list.useQuery({ houseId: house.id })`: `` `${roomsOfHouse.data?.length ?? 0} rooms` ``.
- `HousesMap.tsx:6,60-63`: replace `setLastLocation({ ...getLastLocation(), houseId })` with `useHouse().setHouseId(houseId)` (take `setHouseId` from the hook at the top of the component and keep it in the ref the Leaflet handler reads).
- Delete `src/components/FloorsEditor.tsx`.

- [ ] **Step 5: Verify**

Run: `npm run check` — expect errors only under `src/flow/`. `npx eslint src` clean apart from pre-existing rules.

Manual: sidebar Locations lists the current house's rooms grouped by floor; clicking one filters All Items; pencil → rename works and the item page reflects it instantly; merge moves items; Galaxy "by floor" groups by the room's floor; Map still lists every house's rooms; Rooms page shows unscanned rooms too.

- [ ] **Step 6: Commit**

```bash
git add -A src/components/Layout.tsx src/pages src/components/HousesMap.tsx src/components/FloorsEditor.tsx
git commit -m "Workbench browse views use rooms: sidebar by floor, room filter, rename/merge, Rooms page lists every room"
```

---

### Task 8: Flow front end — "here" is a room

**Files:**
- Modify: `src/flow/data.ts:4,11-12,28-29,38-41,50-71`, `src/flow/context.tsx:3,12,14-15,28-29,37-41,46`, `src/flow/LocationSheet.tsx` (rewrite body), `src/flow/SnapTab.tsx:37,55,71`, `src/flow/SortTab.tsx:138,277-291,359-379`, `src/flow/ActTab.tsx:15,27-36,68`, `src/flow/FindTab.tsx:21`, `src/flow/FlowApp.tsx:68`

**Interfaces:**
- `Place` becomes `{ roomId: number | null }`; `FlowLocation` becomes the `rooms.list` row; `placeLabel(roomId, rooms)` returns `"Keuken · ground"` style label or `""`.

- [ ] **Step 1: data.ts and context.tsx**

```typescript
// src/flow/data.ts — replace the types and helpers that referenced RoomValue / map.listLocations
export type FlowLocation = Out["rooms"]["list"][number];
export type Place = { roomId: number | null };

export const isUnplaced = (it: FlowItem) =>
  it.status === "active" && isReal(it) && !needsCheck(it) && it.roomId == null;

export function placeLabel(roomId: number | null, rooms: FlowLocation[] | undefined): string {
  const r = roomId != null ? rooms?.find((x) => x.id === roomId) : undefined;
  if (!r) return "";
  return r.floor ? `${r.name} · ${r.floor}` : r.name;
}
```

`getSnapPlace`/`setSnapPlace` keep their shape with the new `Place`. In `context.tsx`: `locations` query becomes `trpc.rooms.list.useQuery()` (context house), `here` is seeded from `{ roomId: getLastRoomId() }`, `setHere` calls `setLastRoomId(p.roomId)`, and `refresh` invalidates `rooms.list`. Remove `houses` from the state if nothing else reads it after this task (FindTab stops needing it).

- [ ] **Step 2: LocationSheet**

The sheet lists the context house's rooms sorted by `itemCount` (floor shown as a sub-label), and a "New room" form with name + optional floor select built from the distinct floors in `locations` (fallback `DEFAULT_FLOORS`). Submitting calls `trpc.rooms.ensure` and then `pick({ roomId })`. The house chips row is removed; the header's `HouseSwitcher` (Task 1) is where the house changes. `allowClear` picks `{ roomId: null }`.

- [ ] **Step 3: Tabs**

- `SnapTab.tsx:37,55,71`: `here.room` → `here.roomId != null`.
- `SortTab.tsx:138`: `if (suggestion?.roomId != null) return { roomId: suggestion.roomId };` (unknown room text falls back to `here`); `:277` label `placeLabel(place.roomId, locations) || "No place yet"`; `:289-291` `acceptMany` gets `roomId: place.roomId`; `:359` `update.mutate({ id: item.id, roomId: p.roomId })`; `:368/379` `here.room` → `here.roomId != null`.
- `ActTab.tsx`: drop the house chip row (15, 68) and the `houseId` filter (27-28); the items query already comes scoped from the context house; the room list (32-36) groups by `it.roomId` with labels from `locations`.
- `FindTab.tsx:21`: the haystack uses `it.room?.name`, `it.room?.floor`.
- `FlowApp.tsx:68`: `here.roomId != null ? placeLabel(here.roomId, locations) : "Where are you?"`.

- [ ] **Step 4: Verify**

Run: `npm run check && npx eslint src/flow && npm run build` — clean. Manual on the phone-sized viewport at `/flow/`: "Where are you?" lists rooms of the current house; snapping a photo files it to that room on Sort; Act's progress ring scopes to the house; switching house in the header changes everything.

- [ ] **Step 5: Commit**

```bash
git add src/flow
git commit -m "Flow: a place is a room id; house comes from the session context"
```

---

### Task 9: Schema step B — drop the string columns

**Files:**
- Modify: `db/schema.ts` (items: drop `floor`, `room`; attachments: drop `houseId`, `floor`, `room`; houses: drop `floors`), `api/lib/backfillRooms.ts` (reads the dropped columns: move it to `scripts/backfill-rooms.mjs` as raw SQL, see step 3), `.env.example` nothing
- Create: `db/migrations/0004_drop_location_strings.sql` (generated)
- Delete: `api/test/backfillRooms.test.ts` (its subject no longer compiles against the schema; its behaviour was proven and the production run in Task 10 is logged)

- [ ] **Step 1: Confirm nothing reads the columns**

Run: `grep -rnE 'items\.(floor|room)\b|attachments\.(floor|room|houseId)\b|\.floors\b|\bfloor:|\broom:' api src --include=*.ts --include=*.tsx | grep -v backfillRooms | grep -v 'rooms.floor' | grep -v node_modules`
Expected: only hits that refer to `rooms.floor`, `TriageSuggestion.floor/room` text, or the picker's `floor:` for a new room. Anything else is a leftover to fix before continuing.

- [ ] **Step 2: Schema and migration**

Remove the columns from `db/schema.ts` (items `floor`/`room` and the comment above them; attachments `houseId`/`floor`/`room` and the `att_house_idx` index; houses `floors`). Run `npm run db:generate -- --name drop_location_strings`. Open `0004_drop_location_strings.sql`; it must contain exactly five `DROP COLUMN`s and one `DROP INDEX`, nothing else.

- [ ] **Step 3: Make the backfill independent of the schema module**

Rewrite `scripts/backfill-rooms.mjs` to use `mysql2` and plain SQL so it keeps working on a database that still has the columns (it runs between 0003 and 0004 in production):

```javascript
// scripts/backfill-rooms.mjs — plain SQL version of api/lib/backfillRooms.ts
import "dotenv/config";
import mysql from "mysql2/promise";

const c = await mysql.createConnection({ uri: process.env.DATABASE_URL });
const r = { roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 };
const norm = (s) => (s ?? "").trim().toLowerCase();
const [existing] = await c.query("select id, houseId, name, floor from rooms");
const byKey = new Map(existing.map((x) => [`${x.houseId}|${norm(x.name)}`, x]));

async function roomFor(houseId, name, floor) {
  const key = `${houseId}|${norm(name)}`;
  const hit = byKey.get(key);
  if (hit) {
    if (!hit.floor && floor) { await c.query("update rooms set floor=? where id=?", [floor, hit.id]); hit.floor = floor; r.floorsSet++; }
    return hit.id;
  }
  const [res] = await c.query("insert into rooms (houseId, name, floor, source) values (?,?,?,'manual')", [houseId, name.trim(), floor || null]);
  byKey.set(key, { id: res.insertId, houseId, name: name.trim(), floor: floor || null });
  r.roomsCreated++;
  return res.insertId;
}

const [placed] = await c.query("select i.floor, r.id, r.houseId, r.name, r.floor as roomFloor from items i join rooms r on r.id=i.roomId where i.floor is not null and r.floor is null");
for (const p of placed) { await c.query("update rooms set floor=? where id=? and floor is null", [p.floor, p.id]); r.floorsSet++; byKey.get(`${p.houseId}|${norm(p.name)}`).floor = p.floor; }

const [unplaced] = await c.query("select id, houseId, floor, room from items where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
for (const it of unplaced) { const roomId = await roomFor(it.houseId, it.room, it.floor); await c.query("update items set roomId=? where id=?", [roomId, it.id]); r.itemsLinked++; }

const [photos] = await c.query("select id, houseId, floor, room from attachments where roomId is null and houseId is not null and room is not null and trim(room) <> ''");
for (const a of photos) { const roomId = await roomFor(a.houseId, a.room, a.floor); await c.query("update attachments set roomId=? where id=?", [roomId, a.id]); r.attachmentsLinked++; }

await c.query("update items i join rooms r on r.id=i.roomId set i.houseId=r.houseId where i.houseId <> r.houseId or i.houseId is null");
console.log(r);
await c.end();
```

Delete `api/lib/backfillRooms.ts` and `api/test/backfillRooms.test.ts` (the TS version was the tested reference; the plain-SQL script is line-for-line the same logic and is exercised in Task 10 with a before/after count check). Update the `db:backfill-rooms` script to `node scripts/backfill-rooms.mjs`.

- [ ] **Step 4: Verify everything**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean; the test DB gets 0004 applied in globalSetup.

- [ ] **Step 5: Commit**

```bash
git add -A db/schema.ts db/migrations api/lib/backfillRooms.ts api/test/backfillRooms.test.ts scripts/backfill-rooms.mjs package.json
git commit -m "Drop items.floor/room, attachments.houseId/floor/room and houses.floors; rooms are the only location"
```

---

### Task 10: Production rollout

**Files:** none (operations), plus a short note appended to this plan.

- [ ] **Step 1: Back up**

```bash
mysqldump --single-transaction --host 10.50.0.10 --user declutter -p declutter > ~/declutter-before-rooms-$(date +%Y%m%d-%H%M).sql
```

(From any machine with `mysqldump`; the Mac in use has no MySQL client, so run it on the MySQL host or a machine that has one. Do not proceed without the dump.)

- [ ] **Step 2: Adopt migrations and apply step A**

```bash
npm run db:adopt 0002_item_decision
git checkout <commit of Task 2>      # or run with only 0003 present: drizzle-kit migrate applies journal entries newer than the adopted one in order, so on the final commit it would apply 0003 AND 0004 in one go. The backfill must run in between, so apply 0003 alone first:
npm run db:migrate                   # applies 0003 only when 0004 is not yet in the journal
```

Simplest: check out the Task 2 commit (`git stash` if needed), run `npm run db:migrate`, check out the branch tip again.

- [ ] **Step 3: Backfill and check**

```bash
npm run db:backfill-rooms
```

Expected output, given the live data on 2026-10-02: roughly `{ roomsCreated: 2 (Washok, Keuken), itemsLinked: 43, attachmentsLinked: 3, floorsSet: 5 }`. Verify:

```bash
node -e 'import("dotenv/config").then(async()=>{const m=await import("mysql2/promise");const c=await m.default.createConnection({uri:process.env.DATABASE_URL});for (const q of ["select count(*) n from items where room is not null and roomId is null","select count(*) n from attachments where room is not null and roomId is null","select count(*) n from items i join rooms r on r.id=i.roomId where i.houseId<>r.houseId","select id,name,floor,(walls is not null) scan from rooms order by houseId,floor,name"]) {const [r]=await c.query(q);console.log(q);console.table(r);} await c.end()})'
```

The first three counts must be 0. Run the backfill a second time: it must print all zeros.

- [ ] **Step 4: Apply step B and deploy**

```bash
npm run db:migrate      # applies 0004
npm run build && npm start   # or the usual deploy
```

Open the Workbench and Flow; confirm the sidebar rooms, an item page location, the Inbox room default and Flow's "Where are you?" all show the migrated rooms. Clear `declutter.lastLocation` from localStorage is not required; the new keys are different.

- [ ] **Step 5: Record**

Append to this plan: date, backfill output, and the three verification counts. Commit the note.

```bash
git add docs/superpowers/plans/2026-10-02-rooms-consolidation.md
git commit -m "Rooms consolidation: production rollout notes"
```

---

## Self-Review

**1. Spec coverage.**
- Product rule 1 (floor on the room, never a pick step): Task 2 (column), Task 4 (`ensure`/`create` take floor; `list` sorts by it), Task 6 (picker: floor only in the create row), Task 7 (sidebar grouped by floor, `FloorsEditor` deleted), Task 8 (Flow sheet). ✔
- Product rule 2 (session = house, default last used, switch): Task 1 end to end; Task 5 and 4 make every list default to the context house; Task 7 removes the per-view house pickers. ✔
- Review §4.1 "five location concepts → one": items strings (Tasks 3, 5, 9), attachments copies (Tasks 3, 5, 9), `houses.floors` (Tasks 7, 9), rooms matched by name string (Task 4 `cutFromRoom`/`importGeojson`, Task 5), four "rooms of a house" procedures → `rooms.list` (Task 4). ✔
- Decision "topic is a category": not touched here; the seeded place-like topics stay as categories (re-filing them is a data decision for Rick, not a code change). Noted, not a gap.
- Drag-and-drop: explicitly out of scope at Rick's request. ✔

**2. Placeholder scan.** No TBD/TODO. Task 1 step 3 says "rest of the existing body unchanged" for `areas.list` because only the `where` changes; the full replaced lines are shown. Task 7 gives per-line edits rather than whole-file rewrites for files of 500–900 lines; every edit shows the new code.

**3. Type consistency.** `setItemLocation(db, itemId, { roomId } | { roomId: null; houseId })` is used with that exact shape in Tasks 4, 5. `rooms.list` row shape `{ id, houseId, name, floor, parentRoomId, hasGeometry, itemCount }` is what Tasks 6, 7, 8 read. `TriageSuggestion.roomId` is produced in Task 5 and read in Tasks 6 and 8. `callerFor` is exported from `api/test/areas.test.ts` and imported by later test files; vitest runs files serially so the shared export is safe.

**4. Review Focus coverage.** (1) case-variant duplicate → Task 2 unique test + Task 4 `ensureRoom` test. (2) cross-house move → Task 4 `setItemLocation` test + Task 5 `items.update` test. (3) backfill twice → Task 3 idempotency test. (4) no header → Task 1 context test + Task 4 `rooms.list` no-context test. (5) merge two scanned rooms → Task 4 `rooms.merge` refusal test.
