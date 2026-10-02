# Photos Consolidation (P1: attachments → photos / item_links / photo_pins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `attachments` (images, links, notes and files under one `kind` column) and `photo_annotations` with three single-purpose tables (`photos` for images, `item_links` for link/note/file, `photo_pins` for pins with `photoId`) and move every server path and Workbench call site onto them, while Flow and the Computer Lab adapter keep working through deprecated `attachments.*` aliases.

**Architecture:** The same two-step schema migration `feat/rooms-consolidation` used: migration 0005 adds the new tables, a tested idempotent copy moves the data under the same ids, and migration 0006 drops the old tables only after production runs the new code. New code lives in `api/lib/photos.ts` (shared reads and writes) plus three routers, `photos`, `pins` and `itemLinks`. One cutover task (Task 4) switches all server reads and writes, item deletion, the rooms/houses/wiki/ai consumers and the Workbench call sites in a single commit. `attachments.url/add/remove/listAllImages/listForItem` stay as thin aliases with unchanged inputs and outputs.

**Tech Stack:** Drizzle ORM + drizzle-kit migrations (MySQL 8), tRPC 11 with superjson, React 19, vitest on the test-DB seam (`api/test/db.ts`), sharp (already a dependency) for test fixtures, mysql2 for the copy, Node 25 (runs `.ts` imports from `.mjs` scripts natively, as `scripts/batch-detect-local.mjs` already does).

**Spec:** HomeBase architecture review §4.2 ("a picture of a thing is answered four ways") and roadmap Phase 3; the decisions in `/Users/ricktav/.claude/projects/-Volumes-T7-declutter/memory/homebase-review-decisions.md`; the pre-flight findings and controller rulings R-P1, R-P2 and R-P3 in `.superpowers/sdd/2026-10-02-photos-consolidation/preflight-findings.md`. Sibling plan, whose end state this plan is written against and whose executed rollout it mirrors: `docs/superpowers/plans/2026-10-02-rooms-consolidation.md` (read its Task 2, Task 9 and the "Rollout executed" notes at the end).

**Out of scope (deferred to "P2"):** folding image-kind `captures` rows into `photos`. `captures` stays as it is: the inbox queue that photos and links are filed out of. `photos.sourceCaptureId` and `photos.cropBox` keep their current meaning (a cutout points at the capture it was cropped from). Drag-and-drop stays out of scope at Rick's request. Real foreign keys stay out of scope (router/FK cleanup plan). `captures` stays structurally untouched: no column, procedure or ingestion path (web upload, Telegram) changes; only the write TARGETS of the filing procedures change in the cutover. P2 will also have to decide whether `photos` gets its own `contentHash`/`exifGps` (today only `captures` has them, so a photo added directly from the item page is never deduplicated).

## Design decisions this plan fixes

| decision | choice | why |
|---|---|---|
| Table split | `photos` (images, `storageKey` NOT NULL), `item_links` (`kind` ∈ link/note/file, plus `sourceCaptureId`), `photo_pins` (`photoId`) | One table per kind of thing; `item_links.sourceCaptureId` keeps the provenance `inbox.mergeDuplicates` relies on (finding #11). |
| Ids | The copy preserves ids: `photos.id` and `item_links.id` equal the attachment's id, `photo_pins.id` the annotation's id, `photo_pins.photoId` the annotation's `attachmentId` | Old `/annotate/:id` links, event `entityId`s and pin references stay valid. Idempotency is keyed on the original id, so two identical notes never collapse (finding #13). |
| Deprecated aliases (R-P1) | `attachments.url`, `attachments.add`, `attachments.remove`, `attachments.unlink`, `attachments.listAllImages`, `attachments.listForItem` stay with unchanged inputs and outputs (`unlink` takes only a photo id). Rows that live in `item_links` are returned with the id **negated**; `attachments.remove` routes negative ids to `item_links`, positive ids to `photos` | After the copy, the two tables' id sequences diverge, so a bare number would be ambiguous. Negation keeps the output type (`number`) and makes the round trip exact. |
| Router layout | `photos` (from `attachments.ts` and `map.ts`), `pins` (from `annotations.ts`, same procedure names except `listForAttachment` → `listForPhoto`), `itemLinks` (new) | Files stay focused (`annotations.ts` alone is 364 lines). Frontend renames stay mechanical: `trpc.annotations.X` → `trpc.pins.X`. `api/routers/map.ts` held only the two photo procedures, so it is deleted. |
| Cutover (R-P2) | **Option (a): one cutover task, no dual-write** (Task 4) | Every reader and writer of the old tables switches in one commit, typed end to end by `tsc -b`. A dual-write period would need a second write path in `inbox` and `batch-detect-local.mjs` plus a reconciliation step, which is more code to get wrong than one larger, mechanical commit. Tasks 1–3 only add things nobody calls yet, and Task 5 only removes things nobody calls any more, so every commit on the branch is a working app. |
| Event log | New events use `entityType` `"photo"`, `"item_link"`, `"pin"`; old `"attachment"`/`"annotation"` rows stay | The events table is append-only history. |
| Item cover / AI reference photo | The item's photo with the lowest id (`coverPhotos()`) | That is what the old unordered `select` returned in practice (primary-key order), now made explicit. |

## Global Constraints

- `feat/photos-consolidation` already exists (main e85167d + this plan). The serving tree `/Volumes/T7/declutter` must be on `main` (it serves production from its `dist/`; switching branches there only changes source files, never `dist/`). Implementers work in the worktree `/Volumes/T7/declutter-photos` (created by the controller with `git worktree add /Volumes/T7/declutter-photos feat/photos-consolidation`, `node_modules` symlinked from the serving tree, `.env` copied). Line numbers in this plan refer to e85167d.
- `/Volumes/T7/declutter` is the **production serving tree** (the server on port 3001 runs `dist/boot.js` from it, and its `uploads/` holds the live files). Tasks 1–5 never build, switch branches or run tests there.
- Do not edit anything under `flow/` or `src/flow/` (AGENTS.md §1). If `npm run check` reports errors only under `src/flow/`, a Flow contract broke: stop and report it, do not fix Flow.
- These must stay callable with unchanged input and output shapes: `attachments.url` (Flow, `src/flow/ui.tsx:10`), `items.listAll` including its `imageKey` field (Flow `ActTab`, `FindTab`, `SortTab`), `inbox.acceptMany`, and the adapter-facing `attachments.add`, `attachments.remove`, `attachments.unlink`, `attachments.listAllImages`, `attachments.listForItem`. You may add optional or extra fields.
- No new npm dependencies.
- Schema changes go only through `db/schema.ts` + `npm run db:generate -- --name <tag>`; read the generated SQL; commit the SQL, the snapshot and `meta/_journal.json`. Tags: `0005_add_photos_tables` (Task 1), `0006_drop_attachments` (Task 5). Assumption, verified on 2026-10-02 across every local and remote ref: no other branch has a migration numbered 0005 or higher. Task 1 re-checks this before committing. Never `db:push`. `db:adopt` already ran on production during the rooms rollout and must never be run again.
- Every DB-touching change has a vitest test on the seam: import `getTestDb`/`resetTestDb` from `api/test/db.ts`, call `resetTestDb()` in `beforeEach`, never set `DATABASE_URL` in a test.
- `uploads/` is shared with production when tests run in the serving tree (AGENTS.md §3 CAUTION). Tests write files only through `writeTestJpeg()` (Task 3, `api/test/fixtures.ts`), which uses a fresh random name every time, and clean up with `removeTestUploads()`, which deletes only fixture names and `putFile()` outputs. A literal key in a test is spelled `local/test-fake-<something>` and is only used where no code path deletes files.
- `npm run check`, `npx eslint api src`, `npm test` and `npm run build` pass at the end of every task.
- The production database is touched only in Task 6, and the drop (0006) only after Rick's explicit go, with a backup made first (AGENTS.md §3).
- Commit after every task with the message given in that task.

## Review Focus

1. **Two notes (or two files) on one item that look identical, and an image attachment with no file.** A reasonable person expects every one of their notes to survive the migration, and expects to be told, before anything is dropped, about a photo row that has no file to move. Pinned by Task 2's tests "keeps two identical notes and two same-titled files as separate rows" and "reports and never copies an image without a file".
2. **A cutout or location photo whose source capture's file is gone from disk.** Expected: a readable "Source photo is no longer available." error and no half-made photo row. Pinned by Task 3's test "a source photo that is gone from disk gives a readable error and writes nothing".
3. **An item deleted after the cutover.** Expected: its photos, the pins drawn on those photos, its links/notes/files and their files on disk all go; pins on other photos that pointed at it just lose the link; a file an inbox capture still uses stays. Pinned by Task 4's test "items.remove removes photos, pins on them, links and their files".
4. **A Flow or adapter call through the deprecated `attachments.*` names when a photo and a link have the same numeric id.** Expected: both appear, distinctly, and removing the link leaves the photo alone. Pinned by Task 4's test "never confuse a photo and a link that share a numeric id".
5. **The Photos catalog during and after the migration.** Inbox photos that were never filed must still appear, and a capture that already has a photo must not appear twice. Pinned by Task 3's test "lists filed photos with room, topic and cover flag, plus inbox photos that have no photo yet".

---

## File Structure

- Modify `db/schema.ts`: add `photos`, `itemLinks`, `photoPins` and their types (Task 1); remove `attachments`, `photoAnnotations` and their types (Task 5).
- Create `db/migrations/0005_add_photos_tables.sql` (Task 1) and `db/migrations/0006_drop_attachments.sql` (Task 5), generated.
- Create `api/lib/copyAttachmentsToPhotos.ts`, a plain-SQL copy, plan and verify over a mysql2 connection with no drizzle schema imports, so it still compiles after 0006 (Task 2).
- Create `scripts/copy-attachments-to-photos.mjs`, the CLI around it, `--plan | --copy [--accept-losses] | --verify` (Task 2).
- Create `api/lib/photos.ts`, the shared photo/link reads and writes: `coverPhotos`, `addPhoto`, `removePhoto`, `addItemLink`, `removeItemLink`, `listPhotoCatalog` (Task 3); `LegacyAttachment`, `photoAsLegacy`, `linkAsLegacy`, `legacyAttachmentsForItem` (Task 4).
- Create `api/routers/photos.ts`, `api/routers/pins.ts` and `api/routers/itemLinks.ts` (Task 3).
- Modify `api/routers/attachments.ts`: it becomes the five deprecated aliases (Task 4).
- Delete `api/routers/annotations.ts` and `api/routers/map.ts` (Task 4).
- Modify `api/router.ts` (Tasks 3, 4), `api/lib/entities.ts` (Tasks 3, 4), and `api/routers/inbox.ts`, `items.ts`, `rooms.ts`, `houses.ts`, `wiki.ts`, `ai.ts` plus `scripts/batch-detect-local.mjs` (Task 4).
- Modify these Workbench files (Task 4): `src/App.tsx`, `src/pages/ItemDetail.tsx`, `src/pages/Annotate.tsx`, `src/pages/Photos.tsx`, `src/pages/Map.tsx`, `src/pages/Inbox.tsx`, `src/pages/Activity.tsx`, `src/components/ChooseFromLibraryDialog.tsx`, `src/components/RecropDialog.tsx`, `src/components/Thumb.tsx`, `src/components/GeojsonThumb.tsx`, `src/components/DetectObjects.tsx`.
- Modify docs: `AGENTS.md` §2 and `README.md` (Task 4).
- Tests: create `api/test/photos-schema.test.ts` (Task 1), `api/test/copy-attachments.test.ts` (Task 2, deleted in Task 5), `api/test/fixtures.ts` and `api/test/photos-routers.test.ts` (Task 3), and `api/test/photos-cutover.test.ts` (Task 4). Modify `api/test/houses.test.ts`, `rooms.test.ts`, `items-location.test.ts` and `inbox-location.test.ts` (Task 4).

---

### Task 1: Schema step A: add `photos`, `item_links`, `photo_pins`

**Files:**
- Modify: `db/schema.ts` (insert after the `attachments` table, which ends at line 191; extend the inferred-types block at the end of the file)
- Create: `db/migrations/0005_add_photos_tables.sql`, `db/migrations/meta/0005_snapshot.json` (generated), `db/migrations/meta/_journal.json` (generated update)
- Test: `api/test/photos-schema.test.ts`

**Interfaces:**
- Consumes: `CropBox` (`db/schema.ts:155`).
- Produces: tables `photos` (`id, itemId?, areaId?, roomId?, title?, storageKey (NOT NULL), mimeType?, size?, sourceCaptureId?, cropBox?: CropBox | null, createdAt`), `itemLinks` (`id, itemId?, areaId?, kind: "link" | "note" | "file", title?, content?, url?, storageKey?, mimeType?, size?, sourceCaptureId?, createdAt`), `photoPins` (`id, photoId (NOT NULL), xPct, yPct, wPct?, hPct?, label (default ""), itemId?, origin: "user" | "ai" (default "user"), status: "suggested" | "confirmed" (default "confirmed"), flagged (default false), createdAt`). Types `Photo`, `ItemLink`, `PhotoPin`. Migration tag `0005_add_photos_tables`. Record this task's commit SHA: Task 6 applies 0005 from a worktree pinned at it.

- [ ] **Step 1: Write the failing test**

```typescript
// api/test/photos-schema.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { itemLinks, photoPins, photos } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";

beforeEach(async () => {
  await resetTestDb();
});

describe("photos schema", () => {
  it("stores a photo under an explicit id with its crop box as JSON, and a pin pointing at it", async () => {
    const db = getTestDb();
    await db.insert(photos).values({
      id: 41,
      storageKey: "local/test-fake-schema.jpg",
      sourceCaptureId: 7,
      cropBox: { xPct: 50, yPct: 40, wPct: 20, hPct: 10 },
    });
    await db.insert(photoPins).values({ id: 5, photoId: 41, xPct: 10, yPct: 20, label: "mug" });

    const [p] = await db.select().from(photos).where(eq(photos.id, 41));
    expect(p.cropBox).toEqual({ xPct: 50, yPct: 40, wPct: 20, hPct: 10 });
    expect([p.itemId, p.roomId, p.sourceCaptureId]).toEqual([null, null, 7]);
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.photoId, 41));
    expect([pin.id, pin.status, pin.origin, pin.flagged]).toEqual([5, "confirmed", "user", false]);

    // an explicit id moves the counter past it, which the id-preserving copy relies on
    const [{ id: next }] = await db.insert(photos).values({ storageKey: "local/test-fake-schema-2.jpg" }).$returningId();
    expect(next).toBe(42);
  });

  it("refuses a photo without a storage key", async () => {
    const db = getTestDb();
    await expect(db.insert(photos).values({ storageKey: null as unknown as string })).rejects.toThrow();
  });

  it("keeps two identical notes on one item as two rows, each remembering its capture", async () => {
    const db = getTestDb();
    await db.insert(itemLinks).values([
      { itemId: 1, kind: "note", content: "same", sourceCaptureId: 3 },
      { itemId: 1, kind: "note", content: "same", sourceCaptureId: 3 },
    ]);
    const rows = await db.select().from(itemLinks).where(eq(itemLinks.itemId, 1));
    expect(rows.map((r) => [r.kind, r.content, r.url, r.sourceCaptureId])).toEqual([
      ["note", "same", null, 3],
      ["note", "same", null, 3],
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run api/test/photos-schema.test.ts`
Expected: FAIL. `photos`, `itemLinks` and `photoPins` are not exported from `@db/schema` (a type error, or `Cannot read properties of undefined`).

- [ ] **Step 3: Add the three tables to `db/schema.ts`**

Insert directly after the closing `);` of the `attachments` table (line 191), before the `// Measurements` comment block. Leave `attachments` and `photoAnnotations` in place; this step only adds:

```typescript
// ---------------------------------------------------------------------------
// Photos — images only (replaces attachments with kind "image"). An item's
// photo has itemId; a location photo has roomId and no itemId; a cutout
// carries the capture it was cropped from (sourceCaptureId) and the box.
// ---------------------------------------------------------------------------
export const photos = mysqlTable(
  "photos",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    roomId: bigint("roomId", { mode: "number", unsigned: true }),
    title: varchar("title", { length: 255 }),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    sourceCaptureId: bigint("sourceCaptureId", { mode: "number", unsigned: true }),
    cropBox: json("cropBox").$type<CropBox | null>(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("photos_item_idx").on(t.itemId),
    index("photos_room_idx").on(t.roomId),
    index("photos_source_capture_idx").on(t.sourceCaptureId),
  ],
);

// ---------------------------------------------------------------------------
// Item links — a link, a note or a non-image file on an item (replaces
// attachments with kind "link" | "note" | "file"). sourceCaptureId marks the
// inbox capture it was filed from, so inbox.mergeDuplicates never deletes it.
// ---------------------------------------------------------------------------
export const itemLinks = mysqlTable(
  "item_links",
  {
    id: serial("id").primaryKey(),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    areaId: bigint("areaId", { mode: "number", unsigned: true }),
    kind: varchar("kind", { length: 32 }).$type<"link" | "note" | "file">().notNull(),
    title: varchar("title", { length: 255 }),
    content: text("content"),
    url: text("url"),
    storageKey: varchar("storageKey", { length: 512 }),
    mimeType: varchar("mimeType", { length: 128 }),
    size: bigint("size", { mode: "number" }),
    sourceCaptureId: bigint("sourceCaptureId", { mode: "number", unsigned: true }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("item_links_item_idx").on(t.itemId),
    index("item_links_source_capture_idx").on(t.sourceCaptureId),
  ],
);

// ---------------------------------------------------------------------------
// Photo pins — pins on a photo, optionally linked to an item (replaces
// photo_annotations; attachmentId is now photoId).
// ---------------------------------------------------------------------------
export const photoPins = mysqlTable(
  "photo_pins",
  {
    id: serial("id").primaryKey(),
    photoId: bigint("photoId", { mode: "number", unsigned: true }).notNull(),
    xPct: double("xPct").notNull(),
    yPct: double("yPct").notNull(),
    wPct: double("wPct"),
    hPct: double("hPct"),
    label: varchar("label", { length: 255 }).notNull().default(""),
    itemId: bigint("itemId", { mode: "number", unsigned: true }),
    origin: varchar("origin", { length: 32 }).$type<"user" | "ai">().notNull().default("user"),
    status: varchar("status", { length: 32 }).$type<"suggested" | "confirmed">().notNull().default("confirmed"),
    // "needs attention", independent of confirm status - the Map view's focus marker
    flagged: boolean("flagged").notNull().default(false),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("photo_pins_photo_idx").on(t.photoId), index("photo_pins_item_idx").on(t.itemId)],
);
```

At the end of the file, after `export type PhotoAnnotation = typeof photoAnnotations.$inferSelect;`, add:

```typescript
export type Photo = typeof photos.$inferSelect;
export type ItemLink = typeof itemLinks.$inferSelect;
export type PhotoPin = typeof photoPins.$inferSelect;
```

- [ ] **Step 4: Generate and read the migration**

Run: `npm run db:generate -- --name add_photos_tables`
Expected: `db/migrations/0005_add_photos_tables.sql` with three `CREATE TABLE` statements (`photos`, `item_links`, `photo_pins`) and seven `CREATE INDEX` statements. Open it and confirm there is no `ALTER`, `DROP` or `RENAME`. drizzle-kit must not ask whether a table was renamed: if it does, you are not on the right base (the old tables must still be in `db/schema.ts`). Answer nothing, abort with Ctrl-C and re-check.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run api/test/photos-schema.test.ts`
Expected: PASS, 3 tests (globalSetup applies 0005 to the test database).

- [ ] **Step 6: Confirm no other branch uses migration 0005 or higher**

```bash
git fetch --all --quiet
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes); do
  git ls-tree -r --name-only "$b" -- db/migrations | grep -E '^db/migrations/000[5-9]_' | sed "s|^|$b: |"
done
```

Expected: no output (your new file is not committed yet). If any branch lists a `0005_` file, stop and tell Rick: AGENTS.md §3 forbids two branches using one number.

- [ ] **Step 7: Verify and commit**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean.

```bash
git add db/schema.ts db/migrations api/test/photos-schema.test.ts
git commit -m "Add photos, item_links and photo_pins tables alongside attachments/photo_annotations

Schema step A of the photos consolidation: additive only, so production can
take it before any code reads the new tables. item_links keeps
sourceCaptureId because inbox.mergeDuplicates uses it to protect filed
captures."
git rev-parse --short HEAD   # note this SHA: Task 6 applies 0005 from a worktree at it
```

---

### Task 2: Copy: every attachment and annotation becomes a photo, item link or pin under its own id

**Files:**
- Create: `api/lib/copyAttachmentsToPhotos.ts`
- Create: `scripts/copy-attachments-to-photos.mjs`
- Modify: `package.json` (scripts)
- Test: `api/test/copy-attachments.test.ts`

**Interfaces:**
- Consumes: tables from Task 1 (by SQL name: `photos`, `item_links`, `photo_pins`); the old `attachments` and `photo_annotations`.
- Produces (all take a mysql2 `Connection`, use plain SQL and import nothing from `@db/schema`):
  - `planCopy(c: Connection): Promise<CopyPlan>`, read-only; `CopyPlan = { images: number; links: number; pins: number; imagesWithoutFile: number[]; unknownKind: number[]; nonImageWithRoom: number[]; orphanPins: number[] }`
  - `blockingIds(plan: CopyPlan): number[]`, the attachment ids the copy cannot carry faithfully (`imagesWithoutFile`, `unknownKind`, `nonImageWithRoom`)
  - `copyAttachmentsToPhotos(c: Connection): Promise<CopyResult>`, one transaction, idempotent by original id; `CopyResult = { photosCreated: number; itemLinksCreated: number; pinsCreated: number }`
  - `verifyCopy(c: Connection): Promise<VerifyResult>`, read-only; `VerifyResult = { missingPhotos: number; missingItemLinks: number; missingPins: number; mismatched: number; ok: boolean }`. Only meaningful right after the copy, before the new server writes.
  - npm script `db:copy-photos` → `node scripts/copy-attachments-to-photos.mjs`

- [ ] **Step 1: Write the failing tests**

```typescript
// api/test/copy-attachments.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { attachments, itemLinks, photoAnnotations, photoPins, photos } from "@db/schema";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { blockingIds, copyAttachmentsToPhotos, planCopy, verifyCopy } from "../lib/copyAttachmentsToPhotos";

let conn: mysql.Connection;

beforeAll(async () => {
  // dateStrings: TIMESTAMP values round-trip as strings, so the copy cannot shift them across the DST gap
  conn = await mysql.createConnection({ uri: requireTestDatabaseUrl(), dateStrings: true });
});
afterAll(async () => {
  await conn.end();
});
beforeEach(async () => {
  await resetTestDb();
});

describe("copyAttachmentsToPhotos", () => {
  it("copies images to photos and link/note/file rows to item_links under their own ids, fields intact", async () => {
    const db = getTestDb();
    const box = { xPct: 50, yPct: 50, wPct: 20, hPct: 30 };
    const when = new Date("2025-03-04T05:06:07Z");
    await db.insert(attachments).values([
      { id: 10, itemId: 1, areaId: 2, roomId: 3, kind: "image", title: "Cutout: mug", storageKey: "local/test-fake-a.jpg", mimeType: "image/jpeg", size: 100, sourceCaptureId: 9, cropBox: box, createdAt: when },
      { id: 11, itemId: 1, areaId: 2, kind: "link", title: "Manual", url: "https://example.com/m.pdf", createdAt: when },
      { id: 12, itemId: 1, kind: "file", title: "receipt.pdf", storageKey: "local/test-fake-r.pdf", mimeType: "application/pdf", size: 5, sourceCaptureId: 8 },
    ]);

    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 1, itemLinksCreated: 2, pinsCreated: 0 });

    const [p] = await db.select().from(photos).where(eq(photos.id, 10));
    expect([p.itemId, p.areaId, p.roomId, p.title, p.storageKey, p.mimeType, p.size, p.sourceCaptureId]).toEqual([
      1, 2, 3, "Cutout: mug", "local/test-fake-a.jpg", "image/jpeg", 100, 9,
    ]);
    expect(p.cropBox).toEqual(box);
    expect(p.createdAt.getTime()).toBe(when.getTime());

    const links = await db.select().from(itemLinks).orderBy(asc(itemLinks.id));
    expect(links.map((l) => [l.id, l.kind, l.title, l.url, l.storageKey, l.sourceCaptureId])).toEqual([
      [11, "link", "Manual", "https://example.com/m.pdf", null, null],
      [12, "file", "receipt.pdf", null, "local/test-fake-r.pdf", 8],
    ]);
    expect(links[0].createdAt.getTime()).toBe(when.getTime());
    expect(await db.select().from(attachments)).toHaveLength(3); // the copy never deletes
  });

  it("keeps two identical notes and two same-titled files as separate rows", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 20, itemId: 1, kind: "note", content: "check the fuse" },
      { id: 21, itemId: 1, kind: "note", content: "check the fuse" },
      { id: 22, itemId: 1, kind: "file", title: "scan.pdf", storageKey: "local/test-fake-s.pdf" },
      { id: 23, itemId: 1, kind: "file", title: "scan.pdf", storageKey: "local/test-fake-s.pdf" },
    ]);
    await copyAttachmentsToPhotos(conn);
    expect((await db.select().from(itemLinks).orderBy(asc(itemLinks.id))).map((l) => l.id)).toEqual([20, 21, 22, 23]);
  });

  it("reports and never copies an image without a file; reports a link that carried a room", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 30, itemId: 1, kind: "image", title: "lost" },
      { id: 31, kind: "note", content: "hall note", roomId: 4 },
      { id: 32, itemId: 1, kind: "image", storageKey: "local/test-fake-ok.jpg" },
    ]);
    const plan = await planCopy(conn);
    expect(plan.imagesWithoutFile).toEqual([30]);
    expect(plan.nonImageWithRoom).toEqual([31]);
    expect(blockingIds(plan)).toEqual([30, 31]);
    expect([plan.images, plan.links]).toEqual([1, 1]);

    await copyAttachmentsToPhotos(conn);
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([32]);
    expect((await verifyCopy(conn)).ok).toBe(true);
  });

  it("moves pins onto the photo with the same id and skips pins whose photo is gone", async () => {
    const db = getTestDb();
    await db.insert(attachments).values({ id: 40, kind: "image", storageKey: "local/test-fake-p.jpg" });
    await db.insert(photoAnnotations).values([
      { id: 1, attachmentId: 40, xPct: 10, yPct: 20, wPct: 5, hPct: 6, label: "mug", itemId: 7, origin: "ai", status: "suggested", flagged: true },
      { id: 2, attachmentId: 999, xPct: 1, yPct: 1, label: "orphan" },
    ]);
    const plan = await planCopy(conn);
    expect([plan.pins, plan.orphanPins]).toEqual([1, [2]]);

    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 1, itemLinksCreated: 0, pinsCreated: 1 });
    const pins = await db.select().from(photoPins);
    expect(pins.map((p) => [p.id, p.photoId, p.label, p.itemId, p.origin, p.status, p.flagged, p.wPct])).toEqual([
      [1, 40, "mug", 7, "ai", "suggested", true, 5],
    ]);
  });

  it("is idempotent; verify reports what is missing before the copy and nothing after", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 50, kind: "image", storageKey: "local/test-fake-c.jpg" },
      { id: 51, kind: "note", content: "n" },
    ]);
    await db.insert(photoAnnotations).values({ id: 3, attachmentId: 50, xPct: 1, yPct: 1 });

    expect(await verifyCopy(conn)).toEqual({ missingPhotos: 1, missingItemLinks: 1, missingPins: 1, mismatched: 0, ok: false });
    await copyAttachmentsToPhotos(conn);
    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 0, itemLinksCreated: 0, pinsCreated: 0 });
    expect(await verifyCopy(conn)).toEqual({ missingPhotos: 0, missingItemLinks: 0, missingPins: 0, mismatched: 0, ok: true });
    expect(await db.select().from(photos)).toHaveLength(1);
    // the counter moved past the legacy ids: a fresh photo cannot collide with, or reuse, one
    const [{ id: fresh }] = await db.insert(photos).values({ storageKey: "local/test-fake-fresh.jpg" }).$returningId();
    expect(fresh).toBeGreaterThan(51);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run api/test/copy-attachments.test.ts`
Expected: FAIL with `Cannot find module '../lib/copyAttachmentsToPhotos'` (or the matching type error).

- [ ] **Step 3: Implement `api/lib/copyAttachmentsToPhotos.ts`**

```typescript
// api/lib/copyAttachmentsToPhotos.ts
// One-off data move for the photos consolidation, run between migrations
// 0005 (add photos/item_links/photo_pins) and 0006 (drop attachments/
// photo_annotations). Plain SQL over a mysql2 connection and no imports from
// @db/schema, so this file still compiles after 0006, and
// scripts/copy-attachments-to-photos.mjs can import it under Node's type
// stripping (type-only imports, no enums).
//
// Ids are preserved: photos.id / item_links.id = the attachment's id,
// photo_pins.id = the annotation's id, photo_pins.photoId = its attachmentId.
// "Already copied" therefore means "a row with this id exists", which never
// collapses two notes or files that happen to look alike.
import type { Connection, RowDataPacket } from "mysql2/promise";

export interface CopyPlan {
  /** image attachments with a file: become photos */
  images: number;
  /** link/note/file attachments: become item_links */
  links: number;
  /** annotations on a copyable image: become photo_pins */
  pins: number;
  /** image attachments with no storageKey: NOT copied (photos.storageKey is NOT NULL) */
  imagesWithoutFile: number[];
  /** a kind outside image/link/note/file: NOT copied */
  unknownKind: number[];
  /** link/note/file rows that carry a roomId: copied, but item_links has no roomId */
  nonImageWithRoom: number[];
  /** annotations whose attachment is gone or not a copyable image: NOT copied (already unreachable in the UI) */
  orphanPins: number[];
}

export interface CopyResult {
  photosCreated: number;
  itemLinksCreated: number;
  pinsCreated: number;
}

export interface VerifyResult {
  missingPhotos: number;
  missingItemLinks: number;
  missingPins: number;
  /** copied rows whose key fields differ from their source; only meaningful before the new server writes */
  mismatched: number;
  ok: boolean;
}

type Row = RowDataPacket & Record<string, unknown>;

const LINK_KINDS = new Set(["link", "note", "file"]);

async function rows(c: Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await c.query<Row[]>(sql, params);
  return result;
}

function hasFile(key: unknown): boolean {
  return typeof key === "string" && key !== "";
}

/** mysql2 hands a JSON column back parsed; writing it back through `?` needs a string. */
function jsonOrNull(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

export async function planCopy(c: Connection): Promise<CopyPlan> {
  const plan: CopyPlan = { images: 0, links: 0, pins: 0, imagesWithoutFile: [], unknownKind: [], nonImageWithRoom: [], orphanPins: [] };
  const copyable = new Set<number>();
  for (const a of await rows(c, "select id, kind, storageKey, roomId from attachments order by id")) {
    const id = Number(a.id);
    if (a.kind === "image") {
      if (hasFile(a.storageKey)) {
        plan.images++;
        copyable.add(id);
      } else {
        plan.imagesWithoutFile.push(id);
      }
    } else if (LINK_KINDS.has(String(a.kind))) {
      plan.links++;
      if (a.roomId != null) plan.nonImageWithRoom.push(id);
    } else {
      plan.unknownKind.push(id);
    }
  }
  for (const p of await rows(c, "select id, attachmentId from photo_annotations order by id")) {
    if (copyable.has(Number(p.attachmentId))) plan.pins++;
    else plan.orphanPins.push(Number(p.id));
  }
  return plan;
}

export function blockingIds(plan: CopyPlan): number[] {
  return [...plan.imagesWithoutFile, ...plan.unknownKind, ...plan.nonImageWithRoom];
}

export async function copyAttachmentsToPhotos(c: Connection): Promise<CopyResult> {
  const result: CopyResult = { photosCreated: 0, itemLinksCreated: 0, pinsCreated: 0 };
  await c.beginTransaction();
  try {
    const havePhoto = new Set((await rows(c, "select id from photos")).map((r) => Number(r.id)));
    const haveLink = new Set((await rows(c, "select id from item_links")).map((r) => Number(r.id)));
    const havePin = new Set((await rows(c, "select id from photo_pins")).map((r) => Number(r.id)));
    const copiedImages = new Set<number>();

    for (const a of await rows(c, "select * from attachments order by id")) {
      const id = Number(a.id);
      if (a.kind === "image") {
        if (!hasFile(a.storageKey)) continue; // listed by planCopy().imagesWithoutFile, never invented
        copiedImages.add(id);
        if (havePhoto.has(id)) continue;
        await c.query(
          "insert into photos (id, itemId, areaId, roomId, title, storageKey, mimeType, size, sourceCaptureId, cropBox, createdAt) values (?,?,?,?,?,?,?,?,?,?,?)",
          [id, a.itemId, a.areaId, a.roomId, a.title, a.storageKey, a.mimeType, a.size, a.sourceCaptureId, jsonOrNull(a.cropBox), a.createdAt],
        );
        result.photosCreated++;
      } else if (LINK_KINDS.has(String(a.kind))) {
        if (haveLink.has(id)) continue;
        await c.query(
          "insert into item_links (id, itemId, areaId, kind, title, content, url, storageKey, mimeType, size, sourceCaptureId, createdAt) values (?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, a.itemId, a.areaId, a.kind, a.title, a.content, a.url, a.storageKey, a.mimeType, a.size, a.sourceCaptureId, a.createdAt],
        );
        result.itemLinksCreated++;
      }
    }

    for (const p of await rows(c, "select * from photo_annotations order by id")) {
      const id = Number(p.id);
      if (!copiedImages.has(Number(p.attachmentId)) || havePin.has(id)) continue;
      await c.query(
        "insert into photo_pins (id, photoId, xPct, yPct, wPct, hPct, label, itemId, origin, status, flagged, createdAt) values (?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, p.attachmentId, p.xPct, p.yPct, p.wPct, p.hPct, p.label, p.itemId, p.origin, p.status, p.flagged, p.createdAt],
      );
      result.pinsCreated++;
    }
    await c.commit();
  } catch (err) {
    await c.rollback();
    throw err;
  }
  // The copied rows carry their legacy ids, so each new table's counter must
  // start above the largest legacy id (an explicit-id insert does not always
  // move it far enough, and the old sequences were larger). ALTER TABLE commits
  // implicitly, so these run after the transaction, with the value computed first.
  for (const [table, source] of [
    ["photos", "attachments"],
    ["item_links", "attachments"],
    ["photo_pins", "photo_annotations"],
  ] as const) {
    const next = Number((await rows(c, `select coalesce(max(id), 0) + 1 as n from ${source}`))[0].n);
    await c.query(`ALTER TABLE ${table} AUTO_INCREMENT = ${next}`);
  }
  return result;
}

export async function verifyCopy(c: Connection): Promise<VerifyResult> {
  const count = async (sql: string) => Number((await rows(c, sql))[0].n);
  const missingPhotos = await count(
    "select count(*) n from attachments a left join photos p on p.id = a.id where a.kind = 'image' and a.storageKey is not null and a.storageKey <> '' and p.id is null",
  );
  const missingItemLinks = await count(
    "select count(*) n from attachments a left join item_links l on l.id = a.id where a.kind in ('link','note','file') and l.id is null",
  );
  const missingPins = await count(
    "select count(*) n from photo_annotations x join attachments a on a.id = x.attachmentId and a.kind = 'image' and a.storageKey is not null and a.storageKey <> '' left join photo_pins p on p.id = x.id where p.id is null",
  );
  const mismatched =
    (await count(
      "select count(*) n from attachments a join photos p on p.id = a.id where a.kind = 'image' and not (p.storageKey <=> a.storageKey and p.itemId <=> a.itemId and p.roomId <=> a.roomId and p.sourceCaptureId <=> a.sourceCaptureId)",
    )) +
    (await count(
      "select count(*) n from attachments a join item_links l on l.id = a.id where a.kind in ('link','note','file') and not (l.kind <=> a.kind and l.itemId <=> a.itemId and l.content <=> a.content and l.url <=> a.url and l.storageKey <=> a.storageKey)",
    )) +
    (await count("select count(*) n from photo_annotations x join photo_pins p on p.id = x.id where not (p.photoId <=> x.attachmentId and p.itemId <=> x.itemId)"));
  return {
    missingPhotos,
    missingItemLinks,
    missingPins,
    mismatched,
    ok: missingPhotos + missingItemLinks + missingPins + mismatched === 0,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run api/test/copy-attachments.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the CLI and the npm script**

```javascript
// scripts/copy-attachments-to-photos.mjs
// Photos consolidation data move: runs between migrations 0005 and 0006.
// Reads DATABASE_URL from .env. Logic and tests: api/lib/copyAttachmentsToPhotos.ts
//
//   node scripts/copy-attachments-to-photos.mjs --plan
//       read-only: what would be copied, and which rows cannot be (exit 2 if any)
//   node scripts/copy-attachments-to-photos.mjs --copy [--accept-losses]
//       copy (idempotent), then verify; refuses while --plan lists blocking ids,
//       unless Rick ruled on them and --accept-losses is given
//   node scripts/copy-attachments-to-photos.mjs --verify
//       read-only: every source row has its copy with the same key fields (exit 3 if not)
import "dotenv/config";
import mysql from "mysql2/promise";
import { blockingIds, copyAttachmentsToPhotos, planCopy, verifyCopy } from "../api/lib/copyAttachmentsToPhotos.ts";

const mode = process.argv[2];
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!["--plan", "--copy", "--verify"].includes(mode)) {
  console.error("usage: node scripts/copy-attachments-to-photos.mjs --plan | --copy [--accept-losses] | --verify");
  process.exit(1);
}

// dateStrings: TIMESTAMP values round-trip as strings, so the copy cannot shift them across the DST gap
const c = await mysql.createConnection({ uri: process.env.DATABASE_URL, dateStrings: true });
try {
  const plan = await planCopy(c);
  console.log("plan", plan);
  const blocking = blockingIds(plan);
  if (mode === "--plan") {
    process.exitCode = blocking.length ? 2 : 0;
  } else if (mode === "--verify") {
    const v = await verifyCopy(c);
    console.log("verify", v);
    process.exitCode = v.ok ? 0 : 3;
  } else if (blocking.length && !process.argv.includes("--accept-losses")) {
    console.error(
      `refusing to copy: attachment ids ${blocking.join(", ")} cannot be carried over faithfully (see plan). ` +
        "Ask Rick, then re-run with --accept-losses if he agrees to lose them.",
    );
    process.exitCode = 2;
  } else {
    console.log("copied", await copyAttachmentsToPhotos(c));
    const v = await verifyCopy(c);
    console.log("verify", v);
    process.exitCode = v.ok ? 0 : 3;
  }
} finally {
  await c.end();
}
```

In `package.json` `scripts`, after `"db:adopt": "node db/adopt-migrations.mjs"`, add:

```json
    "db:copy-photos": "node scripts/copy-attachments-to-photos.mjs"
```

(Mind the comma after the `db:adopt` line.)

- [ ] **Step 6: Prove the CLI runs (the `.mjs` → `.ts` import) against the test database**

```bash
TEST_URL="$(node -e 'require("dotenv").config(); process.stdout.write(process.env.TEST_DATABASE_URL)')"
DATABASE_URL="$TEST_URL" npm run db:copy-photos -- --plan; echo "exit $?"
DATABASE_URL="$TEST_URL" npm run db:copy-photos -- --verify; echo "exit $?"
```

Expected: each prints a `plan { images: …, links: …, … }` object (plus `verify { … }` for the second). The exit code is 0, or 2/3 if the last test left a file-less image or an uncopied row behind in the test DB; either is fine here. dotenv never overrides a variable that is already set, so `DATABASE_URL` points at the test database. A `SyntaxError` or `ERR_UNKNOWN_FILE_EXTENSION` means Node is older than 23.6: stop and report.

This proves only that the script runs. The behaviour proof is Step 4's tests. Production gets a read-only `--plan` before anything is written (Task 6, Step 2). Do not restore production data into `declutter_test` to rehearse: AGENTS.md §3 forbids it because `uploads/` is shared.

- [ ] **Step 7: Verify and commit**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean.

```bash
git add api/lib/copyAttachmentsToPhotos.ts api/test/copy-attachments.test.ts scripts/copy-attachments-to-photos.mjs package.json
git commit -m "Copy attachments/photo_annotations into photos/item_links/photo_pins under the same ids

Additive and idempotent by original id, so two identical notes stay two
rows. Rows that cannot be carried faithfully (an image without a file, a
link with a room) are listed by --plan and block --copy until Rick rules.
JSON crop boxes are re-serialized for mysql2."
```

---

### Task 3: Photo library and the `photos`, `pins` and `itemLinks` routers (mounted next to the old ones)

**Files:**
- Create: `api/lib/photos.ts`
- Create: `api/routers/photos.ts`, `api/routers/itemLinks.ts`
- Create: `api/routers/pins.ts` (copied from `api/routers/annotations.ts`, then edited)
- Modify: `api/lib/entities.ts:50-72` (`releaseStoredFiles` also checks `photos` and `item_links`)
- Modify: `api/router.ts` (mount `photos`, `pins`, `itemLinks`; the old `attachments`, `annotations` and `map` stay mounted until Task 4)
- Create: `api/test/fixtures.ts`
- Test: `api/test/photos-routers.test.ts`

Nothing calls the new procedures yet: the app still reads and writes `attachments`, so this commit changes no behaviour. Task 4 switches the app over.

**Interfaces:**
- Consumes: `photos`, `itemLinks`, `photoPins`, `Photo`, `ItemLink` (Task 1); `roomSummary(db, roomIds): Promise<Map<number, RoomSummary>>` (`api/lib/location.ts:72`); `putFile`, `readFileBytes`, `urlForKey` (`api/lib/filestore.ts`); `sniffMime(bytes, fileName?)` (`api/lib/sniff.ts:48`); `cropPercent(bytes, box, maxDim?)` (`api/lib/crop.ts:24`); `logEvent(entry, tx?)` (`api/lib/events.ts`).
- Produces, in `api/lib/photos.ts` (`Db = ReturnType<typeof getDb>`):
  - `type ItemLinkKind = "link" | "note" | "file"`
  - `coverPhotos(db: Db, itemIds?: number[]): Promise<Map<number, { id: number; storageKey: string }>>`, the lowest-id photo per item (all items when `itemIds` is omitted)
  - `addPhoto(db: Db, input: { itemId?: number | null; areaId?: number | null; title?: string | null; storageKey: string; fileName?: string }): Promise<{ id: number; storageKey: string }>`
  - `removePhoto(db: Db, id: number): Promise<{ ok: true }>`, which deletes the photo's pins too and releases the file
  - `addItemLink(db: Db, input: { itemId?: number | null; areaId?: number | null; kind: ItemLinkKind; title?: string | null; content?: string | null; url?: string | null; storageKey?: string | null; fileName?: string; mimeType?: string | null; sourceCaptureId?: number | null }): Promise<{ id: number; storageKey: string | null }>`
  - `removeItemLink(db: Db, id: number): Promise<{ ok: true }>`
  - `interface CatalogRow { source: "photo" | "capture"; id: number; captureId: number | null; storageKey: string | null; createdAt: Date; itemId: number | null; itemName: string | null; itemStatus: "active" | "archived" | null; captureStatus: string | null; roomId: number | null; roomName: string | null; floor: string | null; houseId: number | null; areaName: string | null; isItemCover: boolean }`
  - `listPhotoCatalog(db: Db): Promise<CatalogRow[]>`
- Produces, tRPC (all `procedure`, i.e. app-token guarded):
  - `photos.url({ key: string }) → { url: string | null }`
  - `photos.get({ id: number }) → { photo: Photo | null; url: string | null }` (replaces `attachments.urlForAttachment`, which returned `{ attachment, url }`)
  - `photos.add({ itemId?, areaId?, title?, fileName?, storageKey: string /* "local/…" */ }) → { id: number; storageKey: string }`
  - `photos.remove({ id }) → { ok: true }`
  - `photos.unlink({ id }) → { ok: true }`
  - `photos.listForItem({ itemId }) → Photo[]` (newest first)
  - `photos.sourcePhoto({ photoId }) → { available: false } | { available: true; url: string | null; cropBox: CropBox | null }`
  - `photos.recrop({ photoId, box }) → { ok: true; storageKey: string }`
  - `photos.createCutout({ itemId, sourcePhotoId, box, photoSize?: "small" | "medium" | "big" }) → { id: number; storageKey: string; created: boolean }` (was `attachments.createCutoutFromAttachment` with `sourceAttachmentId`)
  - `photos.listAll() → CatalogRow[]` (was `attachments.listAllImages`; `source` is now `"photo" | "capture"`)
  - `photos.forRoom({ roomId }) → { id: number; storageKey: string }[]` (was `map.photosForLocation`, same output)
  - `photos.ensureForCapture({ captureId, roomId?: number | null }) → { photoId: number }` (was `map.ensureAttachmentForCapture`, which returned `{ attachmentId }`)
  - `pins.listForPhoto({ photoId })`, `pins.listForItem({ itemId })` (rows carry `photoId` and `photo: Photo | null`), `pins.add({ photoId, xPct, yPct, wPct?, hPct?, label?, itemId? }) → { id }`, `pins.update`, `pins.resolve`, `pins.remove`, `pins.detect({ photoId })`, `pins.suggestForBox({ photoId, xPct, yPct, wPct, hPct })`. Every other input and output is as in `annotations.*`.
  - `itemLinks.add({ itemId, areaId?, kind, title?, content?, url?, fileName?, storageKey?, mimeType? }) → { id; storageKey }`, `itemLinks.remove({ id }) → { ok: true }`, `itemLinks.listForItem({ itemId }) → ItemLink[]` (newest first)
- Produces, test helpers in `api/test/fixtures.ts`: `writeTestJpeg(): Promise<string>` (a storage key), `keyPath(key: string): string`, `removeTestUploads(): Promise<void>`.

- [ ] **Step 1: Write the test fixture**

```typescript
// api/test/fixtures.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { captures, itemLinks, photos } from "@db/schema";
import { getTestDb } from "./db";

/**
 * Real image bytes for tests (sharp rejects a 4-byte JPEG stub). uploads/ is
 * shared with the live database when tests run in the serving tree
 * (AGENTS.md section 3), so every file gets a fresh random name, and
 * removeTestUploads() only deletes names this suite can have produced:
 * fixture files (test-<12 hex>.jpg) and putFile() outputs (<12 hex>-...),
 * read from rows that this test itself created after resetTestDb().
 */
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const OURS = /^local\/(test-[0-9a-f]{12}\.jpg|[0-9a-f]{12}-.+)$/;
const written: string[] = [];

export function keyPath(key: string): string {
  return path.join(UPLOAD_DIR, key.replace(/^local\//, ""));
}

/** A real 64x48 JPEG under uploads/ with a unique name; returns its storage key. */
export async function writeTestJpeg(): Promise<string> {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const key = `local/test-${crypto.randomBytes(6).toString("hex")}.jpg`;
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(keyPath(key), bytes);
  written.push(key);
  return key;
}

/** afterEach: delete every file this test wrote or made the app write. */
export async function removeTestUploads(): Promise<void> {
  const db = getTestDb();
  const keys = [
    ...written.splice(0),
    ...(await db.select({ k: photos.storageKey }).from(photos)).map((r) => r.k),
    ...(await db.select({ k: itemLinks.storageKey }).from(itemLinks)).map((r) => r.k),
    ...(await db.select({ k: captures.storageKey }).from(captures)).map((r) => r.k),
  ];
  for (const k of keys) if (k && OURS.test(k)) fs.rmSync(keyPath(k), { force: true });
}
```

- [ ] **Step 2: Write the failing tests**

```typescript
// api/test/photos-routers.test.ts
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, itemLinks, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, writeTestJpeg } from "./fixtures";
import { releaseStoredFiles } from "../lib/entities";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "Kitchen stuff" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, areaId, keuken, itemId };
}

const box = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 };

describe("photos.add / remove", () => {
  it("add sniffs the file; remove deletes the photo, its pins and its file", async () => {
    const { db, h1, itemId, areaId } = await seed();
    const key = await writeTestJpeg();
    const { id } = await callerFor(h1).photos.add({ itemId, areaId, storageKey: key, title: "front" });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.mimeType, row.itemId, (row.size ?? 0) > 0]).toEqual(["image/jpeg", itemId, true]);

    await callerFor(h1).pins.add({ photoId: id, xPct: 10, yPct: 10, label: "handle" });
    await callerFor(h1).photos.remove({ id });
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoPins)).toHaveLength(0);
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });

  it("remove keeps the file while an inbox capture still uses the same key", async () => {
    const { db, h1, itemId } = await seed();
    const key = await writeTestJpeg();
    await db.insert(captures).values({ kind: "image", storageKey: key });
    const { id } = await callerFor(h1).photos.add({ itemId, storageKey: key });
    await callerFor(h1).photos.remove({ id });
    expect(fs.existsSync(keyPath(key))).toBe(true);
  });
});

describe("photos.unlink", () => {
  it("puts the photo back in the pool, in its item's room", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id }] = await db.insert(photos).values({ itemId, storageKey: "local/test-fake-unlink.jpg" }).$returningId();
    await callerFor(h1).photos.unlink({ id });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.itemId, row.roomId]).toEqual([null, keuken]);
  });
});

describe("photos.ensureForCapture / createCutout / recrop", () => {
  it("ensureForCapture makes one bare photo per capture with its own copy of the file, and saves a room given later", async () => {
    const { db, h1, keuken } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();

    const first = await callerFor(h1).photos.ensureForCapture({ captureId: capId });
    const again = await callerFor(h1).photos.ensureForCapture({ captureId: capId, roomId: keuken });
    expect(again.photoId).toBe(first.photoId);

    const [row] = await db.select().from(photos).where(eq(photos.id, first.photoId));
    expect(row.storageKey).not.toBe(capKey);
    expect([row.itemId, row.roomId, row.sourceCaptureId]).toEqual([null, keuken, capId]);
    expect((await callerFor(h1).photos.get({ id: first.photoId })).url).toMatch(/^\/uploads\//);
  });

  it("createCutout crops from the source capture once per item and capture; recrop replaces the file", async () => {
    const { db, h1, itemId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId: capId });

    const a = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    const b = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    expect([a.created, b.created, b.id]).toEqual([true, false, a.id]);
    const [cut] = await db.select().from(photos).where(eq(photos.id, a.id));
    expect([cut.itemId, cut.sourceCaptureId, cut.cropBox]).toEqual([itemId, capId, box]);
    expect(await callerFor(h1).photos.sourcePhoto({ photoId: a.id })).toMatchObject({ available: true, cropBox: box });

    const narrower = { ...box, wPct: 20 };
    const re = await callerFor(h1).photos.recrop({ photoId: a.id, box: narrower });
    const [after] = await db.select().from(photos).where(eq(photos.id, a.id));
    expect([after.storageKey, after.cropBox]).toEqual([re.storageKey, narrower]);
    expect(fs.existsSync(keyPath(a.storageKey))).toBe(false);
  });

  it("a source photo that is gone from disk gives a readable error and writes nothing", async () => {
    const { db, h1, itemId } = await seed();
    const [{ id: capId }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: "local/test-fake-missing-capture.jpg" })
      .$returningId();
    await expect(callerFor(h1).photos.ensureForCapture({ captureId: capId })).rejects.toThrow(/no longer available/);
    expect(await db.select().from(photos)).toHaveLength(0);

    const [{ id: bare }] = await db
      .insert(photos)
      .values({ storageKey: "local/test-fake-missing-photo.jpg", sourceCaptureId: capId })
      .$returningId();
    await expect(callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: bare, box })).rejects.toThrow(/no longer available/);
    await expect(callerFor(h1).photos.recrop({ photoId: bare, box })).rejects.toThrow(/no longer available/);
    expect(await db.select().from(photos)).toHaveLength(1);
  });
});

describe("photos.listAll / forRoom", () => {
  it("lists filed photos with room, topic and cover flag, plus inbox photos that have no photo yet", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: filedCap }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-list-a.jpg" }).$returningId();
    const [{ id: looseCap }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: "local/test-fake-list-b.jpg", status: "triaged" })
      .$returningId();
    await db.insert(captures).values({ kind: "note", rawText: "not a photo" });
    const [{ id: cover }] = await db
      .insert(photos)
      .values({ itemId, storageKey: "local/test-fake-list-c.jpg", sourceCaptureId: filedCap })
      .$returningId();
    const [{ id: second }] = await db.insert(photos).values({ itemId, storageKey: "local/test-fake-list-d.jpg" }).$returningId();
    const [{ id: location }] = await db.insert(photos).values({ roomId: keuken, storageKey: "local/test-fake-list-e.jpg" }).$returningId();

    const rows = await callerFor(h1).photos.listAll();
    const byKey = new Map(rows.map((r) => [`${r.source}:${r.id}`, r]));
    expect(rows).toHaveLength(4);
    expect(byKey.get(`photo:${cover}`)).toMatchObject({
      itemName: "pan",
      roomName: "Keuken",
      floor: "ground",
      houseId: h1,
      areaName: "Kitchen stuff",
      isItemCover: true,
    });
    expect(byKey.get(`photo:${second}`)?.isItemCover).toBe(false);
    expect(byKey.get(`photo:${location}`)).toMatchObject({ itemId: null, roomId: keuken, roomName: "Keuken", isItemCover: false });
    expect(byKey.get(`capture:${looseCap}`)).toMatchObject({ captureId: looseCap, captureStatus: "triaged", isItemCover: false });
    expect(byKey.has(`capture:${filedCap}`)).toBe(false);
  });

  it("forRoom returns the source captures behind cutouts of items in the room", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-forroom-src.jpg" }).$returningId();
    await db.insert(photos).values({ itemId, storageKey: "local/test-fake-forroom-cut.jpg", sourceCaptureId: capId });
    expect(await callerFor(h1).photos.forRoom({ roomId: keuken })).toEqual([{ id: capId, storageKey: "local/test-fake-forroom-src.jpg" }]);
    expect(await callerFor(h1).photos.forRoom({ roomId: 999999 })).toEqual([]);
  });
});

describe("pins", () => {
  it("lists a photo's pins with item names and an item's pins with their photo", async () => {
    const { db, h1, itemId } = await seed();
    const [{ id: photoId }] = await db.insert(photos).values({ storageKey: "local/test-fake-pins.jpg", title: "Kitchen wall" }).$returningId();
    const { id: pinId } = await callerFor(h1).pins.add({ photoId, xPct: 30, yPct: 40, label: "pan", itemId });
    expect((await callerFor(h1).pins.listForPhoto({ photoId })).map((p) => [p.id, p.itemName])).toEqual([[pinId, "pan"]]);
    const forItem = await callerFor(h1).pins.listForItem({ itemId });
    expect([forItem[0].photoId, forItem[0].photo?.title]).toEqual([photoId, "Kitchen wall"]);
    await callerFor(h1).pins.resolve({ id: pinId, confirm: false });
    expect(await db.select().from(photoPins)).toHaveLength(0);
  });

  it("detect on a photo that does not exist says so instead of throwing", async () => {
    const { h1 } = await seed();
    expect(await callerFor(h1).pins.detect({ photoId: 424242 })).toEqual({ ok: false, error: "No stored image for this photo." });
  });
});

describe("itemLinks", () => {
  it("keeps two identical notes, lists newest first, and remove releases a file link's file", async () => {
    const { db, h1, itemId, areaId } = await seed();
    await callerFor(h1).itemLinks.add({ itemId, areaId, kind: "note", content: "same" });
    await callerFor(h1).itemLinks.add({ itemId, areaId, kind: "note", content: "same" });
    const key = await writeTestJpeg();
    const file = await callerFor(h1).itemLinks.add({ itemId, kind: "file", title: "scan", storageKey: key, fileName: "scan.jpg" });

    expect((await callerFor(h1).itemLinks.listForItem({ itemId })).map((l) => l.kind).sort()).toEqual(["file", "note", "note"]);
    const [row] = await db.select().from(itemLinks).where(eq(itemLinks.id, file.id));
    expect(row.mimeType).toBe("image/jpeg");
    await callerFor(h1).itemLinks.remove({ id: file.id });
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });
});

describe("releaseStoredFiles", () => {
  it("keeps a file a photo or a link still uses and deletes one nothing uses", async () => {
    const db = getTestDb();
    const byPhoto = await writeTestJpeg();
    const byLink = await writeTestJpeg();
    const loose = await writeTestJpeg();
    await db.insert(photos).values({ storageKey: byPhoto });
    await db.insert(itemLinks).values({ kind: "file", storageKey: byLink });
    expect(await releaseStoredFiles(db, [byPhoto, byLink, loose])).toBe(1);
    expect([byPhoto, byLink, loose].map((k) => fs.existsSync(keyPath(k)))).toEqual([true, true, false]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run api/test/photos-routers.test.ts`
Expected: FAIL. `callerFor(...).photos` is undefined (no such router); the `releaseStoredFiles` test fails with `expected 3 to be 1` because it ignores `photos` and `item_links`.

- [ ] **Step 4: `releaseStoredFiles` checks every table that can hold a file**

In `api/lib/entities.ts` add `photos` and `itemLinks` to the `@db/schema` import (keep `attachments`; Task 4 removes it) and replace `releaseStoredFiles` (lines 50-72) with:

```typescript
/**
 * Delete stored files only when no other row still points at them. Rows
 * written before phase 1 can share one file between a capture and an
 * attachment, so a plain delete would take the inbox photo with it.
 */
export async function releaseStoredFiles(db: Db, keys: string[]): Promise<number> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return 0;
  const stillUsed = new Set<string>();
  for (const row of await db.select({ k: attachments.storageKey }).from(attachments).where(inArray(attachments.storageKey, unique))) {
    if (row.k) stillUsed.add(row.k);
  }
  for (const row of await db.select({ k: photos.storageKey }).from(photos).where(inArray(photos.storageKey, unique))) {
    stillUsed.add(row.k);
  }
  for (const row of await db.select({ k: itemLinks.storageKey }).from(itemLinks).where(inArray(itemLinks.storageKey, unique))) {
    if (row.k) stillUsed.add(row.k);
  }
  for (const row of await db.select({ k: captures.storageKey }).from(captures).where(inArray(captures.storageKey, unique))) {
    if (row.k) stillUsed.add(row.k);
  }
  let removed = 0;
  for (const k of unique) {
    if (stillUsed.has(k)) continue;
    await deleteStoredFile(k).catch(() => {});
    removed++;
  }
  return removed;
}
```

- [ ] **Step 5: Write `api/lib/photos.ts`**

```typescript
// api/lib/photos.ts
// Shared reads and writes for photos (images) and item_links (link, note,
// file). The photos/pins/itemLinks routers and the deprecated attachments.*
// aliases all go through these, so each table is written one way.
import { asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { areas, captures, itemLinks, items, photoPins, photos } from "@db/schema";
import type { getDb } from "../queries/connection";
import { readFileBytes } from "./filestore";
import { sniffMime } from "./sniff";
import { logEvent } from "./events";
import { releaseStoredFiles } from "./entities";
import { roomSummary } from "./location";

type Db = ReturnType<typeof getDb>;

export type ItemLinkKind = "link" | "note" | "file";

/** First photo (lowest id) of each item: its cover thumbnail and its AI
 * reference photo. Every item with a photo when itemIds is omitted. */
export async function coverPhotos(db: Db, itemIds?: number[]): Promise<Map<number, { id: number; storageKey: string }>> {
  const out = new Map<number, { id: number; storageKey: string }>();
  if (itemIds && itemIds.length === 0) return out;
  const rows = await db
    .select({ id: photos.id, itemId: photos.itemId, storageKey: photos.storageKey })
    .from(photos)
    .where(itemIds ? inArray(photos.itemId, itemIds) : isNotNull(photos.itemId))
    .orderBy(asc(photos.id));
  for (const r of rows) if (r.itemId != null && !out.has(r.itemId)) out.set(r.itemId, { id: r.id, storageKey: r.storageKey });
  return out;
}

export async function addPhoto(
  db: Db,
  input: { itemId?: number | null; areaId?: number | null; title?: string | null; storageKey: string; fileName?: string },
): Promise<{ id: number; storageKey: string }> {
  const bytes = await readFileBytes(input.storageKey);
  const mimeType = await sniffMime(bytes, input.fileName);
  const [{ id }] = await db
    .insert(photos)
    .values({
      itemId: input.itemId ?? null,
      areaId: input.areaId ?? null,
      title: input.title ?? null,
      storageKey: input.storageKey,
      mimeType,
      size: bytes.byteLength,
    })
    .$returningId();
  await logEvent({
    entityType: "photo",
    entityId: id,
    action: "created",
    summary: `Photo "${input.title ?? input.fileName ?? id}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
    payload: { itemId: input.itemId ?? null, areaId: input.areaId ?? null },
  });
  return { id, storageKey: input.storageKey };
}

/** Delete a photo and the pins drawn on it; the file goes only if nothing else uses it. */
export async function removePhoto(db: Db, id: number): Promise<{ ok: true }> {
  const row = await db.query.photos.findFirst({ where: eq(photos.id, id) });
  await db.transaction(async (tx) => {
    await tx.delete(photoPins).where(eq(photoPins.photoId, id));
    await tx.delete(photos).where(eq(photos.id, id));
    await logEvent({ entityType: "photo", entityId: id, action: "deleted", summary: `Photo "${row?.title ?? id}" removed` }, tx);
  });
  if (row) await releaseStoredFiles(db, [row.storageKey]);
  return { ok: true as const };
}

/** Un-pin a photo from its item without deleting it: it goes back to the
 * Photos pool, keeping the item's room so it does not lose its place. Used by
 * photos.unlink and the deprecated attachments.unlink alias. */
export async function unlinkPhoto(db: Db, id: number): Promise<{ ok: true }> {
  const photo = await db.query.photos.findFirst({ where: eq(photos.id, id) });
  if (!photo) throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found." });
  const item = photo.itemId ? await db.query.items.findFirst({ where: eq(items.id, photo.itemId) }) : null;
  await db
    .update(photos)
    .set({ itemId: null, roomId: photo.roomId ?? item?.roomId ?? null })
    .where(eq(photos.id, id));
  await logEvent({
    entityType: "photo",
    entityId: id,
    action: "unlinked",
    summary: `Photo "${photo.title ?? id}" unlinked from item #${photo.itemId} - back in the photo pool`,
  });
  return { ok: true as const };
}

export async function addItemLink(
  db: Db,
  input: {
    itemId?: number | null;
    areaId?: number | null;
    kind: ItemLinkKind;
    title?: string | null;
    content?: string | null;
    url?: string | null;
    storageKey?: string | null;
    fileName?: string;
    mimeType?: string | null;
    sourceCaptureId?: number | null;
  },
): Promise<{ id: number; storageKey: string | null }> {
  let storageKey: string | null = null;
  let size: number | null = null;
  let mimeType = input.mimeType ?? null;
  if (input.kind === "file" && input.storageKey) {
    const bytes = await readFileBytes(input.storageKey);
    mimeType = await sniffMime(bytes, input.fileName);
    storageKey = input.storageKey;
    size = bytes.byteLength;
  }
  const [{ id }] = await db
    .insert(itemLinks)
    .values({
      itemId: input.itemId ?? null,
      areaId: input.areaId ?? null,
      kind: input.kind,
      title: input.title ?? null,
      content: input.content ?? null,
      url: input.url ?? null,
      storageKey,
      mimeType,
      size,
      sourceCaptureId: input.sourceCaptureId ?? null,
    })
    .$returningId();
  await logEvent({
    entityType: "item_link",
    entityId: id,
    action: "created",
    summary: `${input.kind} "${input.title ?? input.fileName ?? input.url ?? "note"}" added${input.itemId ? ` to item #${input.itemId}` : ""}`,
    payload: { itemId: input.itemId ?? null, areaId: input.areaId ?? null, kind: input.kind },
  });
  return { id, storageKey };
}

export async function removeItemLink(db: Db, id: number): Promise<{ ok: true }> {
  const row = await db.query.itemLinks.findFirst({ where: eq(itemLinks.id, id) });
  await db.transaction(async (tx) => {
    await tx.delete(itemLinks).where(eq(itemLinks.id, id));
    await logEvent({ entityType: "item_link", entityId: id, action: "deleted", summary: `${row?.kind ?? "link"} "${row?.title ?? id}" removed` }, tx);
  });
  if (row?.storageKey) await releaseStoredFiles(db, [row.storageKey]);
  return { ok: true as const };
}

export interface CatalogRow {
  source: "photo" | "capture";
  id: number;
  captureId: number | null;
  storageKey: string | null;
  createdAt: Date;
  itemId: number | null;
  itemName: string | null;
  itemStatus: "active" | "archived" | null;
  captureStatus: string | null;
  roomId: number | null;
  roomName: string | null;
  floor: string | null;
  houseId: number | null;
  areaName: string | null;
  isItemCover: boolean;
}

/** The Photos page catalog: every photo whatever its state (item photo,
 * location photo, bare photo made pinnable), plus every inbox image capture
 * that no photo was made from yet, newest first. */
export async function listPhotoCatalog(db: Db): Promise<CatalogRow[]> {
  const all = await db.select().from(photos).orderBy(desc(photos.createdAt));
  const itemIds = [...new Set(all.map((p) => p.itemId).filter((id): id is number => id != null))];
  const allItems = itemIds.length ? await db.select().from(items).where(inArray(items.id, itemIds)) : [];
  const itemById = new Map(allItems.map((i) => [i.id, i]));
  const areaById = new Map((await db.select().from(areas)).map((a) => [a.id, a]));
  const roomsById = await roomSummary(
    db,
    [...allItems.map((i) => i.roomId), ...all.map((p) => p.roomId)].filter((x): x is number => x != null),
  );
  const covers = await coverPhotos(db, itemIds);

  const photoRows: CatalogRow[] = all.map((p) => {
    const it = p.itemId != null ? itemById.get(p.itemId) : undefined;
    const roomId = it?.roomId ?? p.roomId ?? null;
    const room = roomId != null ? roomsById.get(roomId) : undefined;
    return {
      source: "photo",
      id: p.id,
      captureId: null,
      storageKey: p.storageKey,
      createdAt: p.createdAt,
      itemId: p.itemId ?? null,
      itemName: it?.name ?? null,
      itemStatus: it?.status ?? null,
      captureStatus: null,
      roomId,
      roomName: room?.name ?? null,
      floor: room?.floor ?? null,
      houseId: room?.houseId ?? it?.houseId ?? null,
      areaName: it ? (areaById.get(it.areaId)?.name ?? null) : null,
      isItemCover: p.itemId != null && covers.get(p.itemId)?.id === p.id,
    };
  });

  const filedCaptureIds = new Set(all.map((p) => p.sourceCaptureId).filter((id): id is number => id != null));
  const imageCaptures = await db.select().from(captures).where(eq(captures.kind, "image")).orderBy(desc(captures.createdAt));
  const captureRows: CatalogRow[] = imageCaptures
    .filter((c) => !filedCaptureIds.has(c.id))
    .map((c) => ({
      source: "capture",
      id: c.id,
      captureId: c.id,
      storageKey: c.storageKey,
      createdAt: c.createdAt,
      itemId: null,
      itemName: null,
      itemStatus: null,
      captureStatus: c.status,
      roomId: null,
      roomName: null,
      floor: null,
      houseId: null,
      areaName: null,
      isItemCover: false,
    }));

  return [...photoRows, ...captureRows].sort((a, b) => +b.createdAt - +a.createdAt);
}
```

- [ ] **Step 6: Write `api/routers/photos.ts`**

```typescript
// api/routers/photos.ts
// Images: an item's photos, location photos, cutouts and the catalog.
// Absorbs the image half of api/routers/attachments.ts and the two photo
// procedures of api/routers/map.ts.
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { captures, items, photos } from "@db/schema";
import { putFile, readFileBytes, urlForKey } from "../lib/filestore";
import { releaseStoredFiles } from "../lib/entities";
import { cropPercent } from "../lib/crop";
import { logEvent } from "../lib/events";
import { addPhoto, listPhotoCatalog, removePhoto, unlinkPhoto } from "../lib/photos";

// `photos.unlink` delegates to `unlinkPhoto` in api/lib/photos.ts (Step 5), so
// the deprecated attachments.unlink alias (Task 4) shares one implementation.
// Drop any import above (`items`, `logEvent`, `TRPCError`, `eq`...) that no
// other procedure in this file still uses; `npx eslint api` flags them.
const cropBoxInput = z.object({
  xPct: z.number().min(0).max(100),
  yPct: z.number().min(0).max(100),
  wPct: z.number().min(1).max(100),
  hPct: z.number().min(1).max(100),
});

/** Bytes of a source file, or a readable error when it is gone from disk. */
async function readSourceBytes(key: string): Promise<Uint8Array> {
  try {
    return await readFileBytes(key);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
  }
}

export const photosRouter = createRouter({
  /** Same-origin URL for any stored key (photo, capture, file). */
  url: procedure.input(z.object({ key: z.string() })).query(async ({ input }) => ({ url: await urlForKey(input.key) })),

  get: procedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const photo = await getDb().query.photos.findFirst({ where: eq(photos.id, input.id) });
    if (!photo) return { photo: null, url: null };
    return { photo, url: await urlForKey(photo.storageKey) };
  }),

  add: procedure
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        title: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload */
        storageKey: z.string().startsWith("local/"),
      }),
    )
    .mutation(({ input }) => addPhoto(getDb(), input)),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => removePhoto(getDb(), input.id)),

  /** Un-pin a photo from its item without deleting it: it goes back to the
   * Photos pool, keeping the item's room so it does not lose its place. */
  unlink: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => unlinkPhoto(getDb(), input.id)),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb().select().from(photos).where(eq(photos.itemId, input.itemId)).orderBy(desc(photos.createdAt)),
  ),

  /** The original photo a cutout was cropped from, plus its current box, for the re-crop UI. */
  sourcePhoto: procedure.input(z.object({ photoId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const photo = await db.query.photos.findFirst({ where: eq(photos.id, input.photoId) });
    if (!photo?.sourceCaptureId) return { available: false as const };
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, photo.sourceCaptureId) });
    if (!cap?.storageKey) return { available: false as const };
    return { available: true as const, url: await urlForKey(cap.storageKey), cropBox: photo.cropBox ?? null };
  }),

  /** Re-crop a cutout from its source photo with a new box; replaces the file in place. */
  recrop: procedure.input(z.object({ photoId: z.number(), box: cropBoxInput })).mutation(async ({ input }) => {
    const db = getDb();
    const photo = await db.query.photos.findFirst({ where: eq(photos.id, input.photoId) });
    if (!photo?.sourceCaptureId) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This cutout has no source photo to re-crop from." });
    }
    const cap = await db.query.captures.findFirst({ where: eq(captures.id, photo.sourceCaptureId) });
    if (!cap?.storageKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
    const cropped = await cropPercent(await readSourceBytes(cap.storageKey), input.box);
    const saved = await putFile({
      bytes: new Uint8Array(cropped),
      fileName: `items/${photo.itemId ?? "photo"}/cutout-${Date.now()}.jpg`,
      contentType: "image/jpeg",
    });
    await db.transaction(async (tx) => {
      await tx.update(photos).set({ storageKey: saved.key, size: saved.size, cropBox: input.box }).where(eq(photos.id, input.photoId));
      await logEvent(
        {
          entityType: "photo",
          entityId: input.photoId,
          action: "recropped",
          summary: `Cutout "${photo.title ?? input.photoId}" re-cropped from its source photo`,
        },
        tx,
      );
    });
    await releaseStoredFiles(db, [photo.storageKey]);
    return { ok: true, storageKey: saved.key };
  }),

  /** Give an item a photo cropped out of another photo (its source capture
   * when it has one, else the photo itself), e.g. when pinning a new object. */
  createCutout: procedure
    .input(
      z.object({
        itemId: z.number(),
        sourcePhotoId: z.number(),
        box: cropBoxInput,
        photoSize: z.enum(["small", "medium", "big"]).default("big"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const source = await db.query.photos.findFirst({ where: eq(photos.id, input.sourcePhotoId) });
      if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source photo not found." });

      let bytes: Uint8Array;
      let sourceCaptureId: number | null = null;
      if (source.sourceCaptureId) {
        const cap = await db.query.captures.findFirst({ where: eq(captures.id, source.sourceCaptureId) });
        if (!cap?.storageKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
        bytes = await readSourceBytes(cap.storageKey);
        sourceCaptureId = cap.id;
      } else {
        bytes = await readSourceBytes(source.storageKey);
      }

      // one cutout per item and original photo: pinning again or re-saving does not pile up copies
      if (sourceCaptureId) {
        const dup = await db.query.photos.findFirst({
          where: and(eq(photos.itemId, input.itemId), eq(photos.sourceCaptureId, sourceCaptureId)),
        });
        if (dup) return { id: dup.id, storageKey: dup.storageKey, created: false as const };
      }

      const maxDim = { small: 480, medium: 900, big: undefined }[input.photoSize];
      const cropped = await cropPercent(bytes, input.box, maxDim);
      const saved = await putFile({
        bytes: new Uint8Array(cropped),
        fileName: `items/${input.itemId}/cutout-${Date.now()}.jpg`,
        contentType: "image/jpeg",
      });
      const [{ id }] = await db
        .insert(photos)
        .values({
          itemId: input.itemId,
          storageKey: saved.key,
          mimeType: "image/jpeg",
          size: saved.size,
          sourceCaptureId,
          cropBox: input.box,
          title: "Photo",
        })
        .$returningId();
      await logEvent({
        entityType: "photo",
        entityId: id,
        action: "created",
        summary: `Photo cropped from pin location and added to item #${input.itemId}`,
      });
      return { id, storageKey: saved.key, created: true as const };
    }),

  listAll: procedure.query(() => listPhotoCatalog(getDb())),

  /** The photo pool for a room: every source capture behind the cutouts of the room's active items. */
  forRoom: procedure.input(z.object({ roomId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const roomItems = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.status, "active"), eq(items.roomId, input.roomId)));
    if (!roomItems.length) return [];
    const cutouts = await db
      .select({ sourceCaptureId: photos.sourceCaptureId })
      .from(photos)
      .where(and(inArray(photos.itemId, roomItems.map((i) => i.id)), isNotNull(photos.sourceCaptureId)));
    const captureIds = [...new Set(cutouts.map((c) => c.sourceCaptureId).filter((x): x is number => x != null))];
    if (!captureIds.length) return [];
    const caps = await db
      .select({ id: captures.id, storageKey: captures.storageKey })
      .from(captures)
      .where(inArray(captures.id, captureIds))
      .orderBy(asc(captures.id));
    return caps.filter((c): c is { id: number; storageKey: string } => !!c.storageKey);
  }),

  /** The pin canvas (/annotate/:photoId) works on a photo; a pool or inbox
   * image is only a capture until now. Find-or-create one bare, item-less
   * photo per capture (reused on repeat visits) so it becomes pinnable. */
  ensureForCapture: procedure
    .input(z.object({ captureId: z.number(), roomId: z.number().nullable().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      // itemId IS NULL: a cutout carries the same sourceCaptureId but is a crop, not the full photo
      const existing = await db.query.photos.findFirst({
        where: and(eq(photos.sourceCaptureId, input.captureId), isNull(photos.itemId)),
      });
      if (existing) {
        // a room confirmed just now (Inbox's pending-item "Pin" flow) is worth keeping
        if (input.roomId != null && existing.roomId == null) {
          await db.update(photos).set({ roomId: input.roomId }).where(eq(photos.id, existing.id));
        }
        return { photoId: existing.id };
      }
      const cap = await db.query.captures.findFirst({ where: eq(captures.id, input.captureId) });
      if (!cap?.storageKey) throw new TRPCError({ code: "NOT_FOUND", message: "Capture has no stored photo." });
      // own copy of the bytes: a capture and a photo never share a key
      const copy = await putFile({
        bytes: await readSourceBytes(cap.storageKey),
        fileName: `locations/${cap.storageKey.split("/").pop() ?? "photo"}`,
        contentType: "image/jpeg",
      });
      const [{ id }] = await db
        .insert(photos)
        .values({
          storageKey: copy.key,
          size: copy.size,
          mimeType: "image/jpeg",
          sourceCaptureId: cap.id,
          roomId: input.roomId ?? null,
          title: "Location photo",
        })
        .$returningId();
      await logEvent({ entityType: "photo", entityId: id, action: "created", summary: `Location photo created from capture #${cap.id}` });
      return { photoId: id };
    }),
});
```

- [ ] **Step 7: Write `api/routers/itemLinks.ts`**

```typescript
// api/routers/itemLinks.ts
// Links, notes and non-image files on an item.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { itemLinks } from "@db/schema";
import { addItemLink, removeItemLink } from "../lib/photos";

export const itemLinksRouter = createRouter({
  add: procedure
    .input(
      z.object({
        itemId: z.number(),
        areaId: z.number().optional(),
        kind: z.enum(["link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload, for kind "file" */
        storageKey: z.string().startsWith("local/").optional(),
        mimeType: z.string().optional(),
      }),
    )
    .mutation(({ input }) => addItemLink(getDb(), input)),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => removeItemLink(getDb(), input.id)),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) =>
    getDb().select().from(itemLinks).where(eq(itemLinks.itemId, input.itemId)).orderBy(desc(itemLinks.createdAt)),
  ),
});
```

- [ ] **Step 8: Create `api/routers/pins.ts` from `annotations.ts`**

`annotations.ts` stays mounted and untouched until Task 4. Copy it and apply mechanical renames:

```bash
cp api/routers/annotations.ts api/routers/pins.ts
sed -i '' \
  -e 's/photoAnnotations/photoPins/g' \
  -e 's/attachmentId/photoId/g' \
  -e 's/db\.query\.attachments/db.query.photos/g' \
  -e 's/eq(attachments\.id,/eq(photos.id,/g' \
  -e 's/entityType: "annotation"/entityType: "pin"/g' \
  -e 's/No stored image for this attachment\./No stored image for this photo./g' \
  -e 's/export const annotationsRouter/export const pinsRouter/' \
  -e 's/  listForAttachment: procedure/  listForPhoto: procedure/' \
  api/routers/pins.ts
```

Then make three edits by hand in `api/routers/pins.ts`.

(a) Replace the import lines `import { eq, or, desc } from "drizzle-orm";` and `import { photoPins, attachments, items, areas } from "@db/schema";` with:

```typescript
import { eq, or, desc, inArray } from "drizzle-orm";
import { photoPins, photos, items, areas } from "@db/schema";
import { coverPhotos } from "../lib/photos";
```

(b) In `buildReferenceContent`, replace these lines:

```typescript
  const photoRows = await db
    .select({ itemId: attachments.itemId, storageKey: attachments.storageKey })
    .from(attachments)
    .where(eq(attachments.kind, "image"));
  const photoByItem = new Map<number, string>();
  for (const p of photoRows) {
    if (p.itemId && p.storageKey && !photoByItem.has(p.itemId)) photoByItem.set(p.itemId, p.storageKey);
  }
```

with:

```typescript
  const photoByItem = new Map([...(await coverPhotos(db))].map(([itemId, p]) => [itemId, p.storageKey] as const));
```

(c) Replace the whole `listForItem` procedure (from the `/** items pinned anywhere (back-references for the item page) */` comment to its closing `}),`) with:

```typescript
  /** items pinned anywhere (back-references for the item page) */
  listForItem: procedure.input(z.object({ itemId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const pins = await db.select().from(photoPins).where(eq(photoPins.itemId, input.itemId));
    const photoIds = [...new Set(pins.map((p) => p.photoId))];
    const pics = photoIds.length ? await db.select().from(photos).where(inArray(photos.id, photoIds)) : [];
    const byId = new Map(pics.map((p) => [p.id, p]));
    return pins.map((p) => ({ ...p, photo: byId.get(p.photoId) ?? null }));
  }),
```

Check: `grep -n "ttachment" api/routers/pins.ts` prints nothing.

- [ ] **Step 9: Mount the routers**

In `api/router.ts` add, after `import { mapRouter } from "./routers/map";`:

```typescript
import { photosRouter } from "./routers/photos";
import { pinsRouter } from "./routers/pins";
import { itemLinksRouter } from "./routers/itemLinks";
```

and after `  map: mapRouter,`:

```typescript
  photos: photosRouter,
  pins: pinsRouter,
  itemLinks: itemLinksRouter,
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run api/test/photos-routers.test.ts`
Expected: PASS, 12 tests. Then `ls uploads | grep -c '^test-'` prints `0` (the fixture cleaned up after itself).

- [ ] **Step 11: Verify and commit**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean. The old routers still serve the app; nothing calls the new ones yet.

```bash
git add api/lib/photos.ts api/lib/entities.ts api/routers/photos.ts api/routers/pins.ts api/routers/itemLinks.ts api/router.ts api/test/fixtures.ts api/test/photos-routers.test.ts
git commit -m "Add the photos, pins and itemLinks routers on the new tables, next to the old ones

The shared reads and writes live in api/lib/photos.ts so routers and the
upcoming attachments.* aliases write each table one way. Nothing calls the
new procedures yet; the cutover is one later commit. releaseStoredFiles now
also protects files held by photos and item_links. Tests use a real
sharp-made JPEG with a unique name, because uploads/ is shared."
```

---

### Task 4: Cutover: server reads and writes, deletes, the deprecated aliases and the Workbench, in one commit

This is the R-P2 cutover (option (a), see Design decisions). After this commit nothing reads or writes `attachments` or `photo_annotations` except the copy library. Every filing path writes `photos`/`item_links`, every reader reads them, `deleteItemTx` cleans them up, and the Workbench calls the new procedures. Do not commit part of it: until every step is done the branch either does not type-check or files photos where no screen looks. If you have to stop midway, `git stash` the work instead of committing it.

**Files:**
- Modify: `api/lib/photos.ts` (add the legacy-shape helpers)
- Modify: `api/lib/entities.ts` (`deleteItemTx` lines 25-48; `releaseStoredFiles` drops its `attachments` check)
- Modify: `api/routers/inbox.ts` (import line 7; `detectObjects` lines 351-358; `fileObject` lines 498 and 512-522; `acceptMany` lines 590-615; `mergeDuplicates` lines 803-812)
- Modify: `api/routers/items.ts` (imports lines 2 and 6; `listByArea` lines 43-51; `listAll` lines 80-89; `get` lines 104-108 and 156)
- Modify: `api/routers/rooms.ts` (lines 6, 237-238, 363, 384), `api/routers/houses.ts` (lines 6-19, 140, 183)
- Modify: `api/routers/wiki.ts` (line 6, line 45), `api/routers/ai.ts` (line 6, line 17)
- Rewrite: `api/routers/attachments.ts` (the five deprecated aliases)
- Delete: `api/routers/annotations.ts`, `api/routers/map.ts`
- Modify: `api/router.ts`
- Modify: `scripts/batch-detect-local.mjs` (lines 89-99, 116-126)
- Modify: `src/App.tsx:41`, `src/pages/ItemDetail.tsx`, `src/pages/Annotate.tsx`, `src/pages/Photos.tsx`, `src/pages/Map.tsx`, `src/pages/Inbox.tsx`, `src/pages/Activity.tsx:6`, `src/components/ChooseFromLibraryDialog.tsx`, `src/components/RecropDialog.tsx`, `src/components/Thumb.tsx`, `src/components/GeojsonThumb.tsx`, `src/components/DetectObjects.tsx`
- Modify: `AGENTS.md` §2, `README.md:41`
- Test: create `api/test/photos-cutover.test.ts`; modify `api/test/houses.test.ts`, `api/test/rooms.test.ts`, `api/test/items-location.test.ts`, `api/test/inbox-location.test.ts`

**Interfaces:**
- Consumes: everything Task 3 produces (`coverPhotos`, `addPhoto`, `removePhoto`, `addItemLink`, `removeItemLink`, `listPhotoCatalog`, `CatalogRow`, routers `photos`, `pins`, `itemLinks`, test helpers `writeTestJpeg`, `keyPath`, `removeTestUploads`).
- Produces, in `api/lib/photos.ts`:
  - `interface LegacyAttachment { id: number; itemId: number | null; areaId: number | null; roomId: number | null; kind: "image" | ItemLinkKind; title: string | null; content: string | null; url: string | null; storageKey: string | null; mimeType: string | null; size: number | null; sourceCaptureId: number | null; cropBox: CropBox | null; createdAt: Date }`
  - `photoAsLegacy(p: Photo): LegacyAttachment` (id unchanged)
  - `linkAsLegacy(l: ItemLink): LegacyAttachment` (id **negated**)
  - `legacyAttachmentsForItem(db: Db, itemId: number): Promise<LegacyAttachment[]>` (newest first)
- Produces, tRPC:
  - `items.get` now returns `photos: Photo[]`, `links: ItemLink[]` (each newest first) and a deprecated `attachments: LegacyAttachment[]` array (photos plus links in the old shape, newest first; link ids negated) for external callers. `items.listByArea` and `items.listAll` keep `imageKey: string | null`, now the storage key of `coverPhotos()`.
  - Deprecated aliases, inputs and outputs unchanged: `attachments.url({ key }) → { url }`, `attachments.add({ itemId?, areaId?, kind, title?, content?, url?, fileName?, storageKey?, mimeType? }) → { id: number; storageKey: string | null }` (a negative id for link/note/file), `attachments.remove({ id }) → { ok: true }` (negative → `item_links`), `attachments.unlink({ id }) → { ok: true }` (photo ids only; a negative id is BAD_REQUEST), `attachments.listAllImages() → (CatalogRow with source "attachment" | "capture")[]`, `attachments.listForItem({ itemId }) → LegacyAttachment[]`. One deliberate change: `attachments.add` with `kind: "image"` and no `storageKey` now fails (BAD_REQUEST) instead of writing a photo row with no file.
  - Removed: `annotations.*` (use `pins.*`), `map.photosForLocation` (use `photos.forRoom`), `map.ensureAttachmentForCapture` (use `photos.ensureForCapture`, which returns `{ photoId }`), `attachments.urlForAttachment`, `attachments.sourcePhoto`, `attachments.recrop`, `attachments.createCutoutFromAttachment` (use the `photos.*` equivalents).
  - `houses.impact` and `houses.reassign` `photoCount` now count photos only. The old count included notes and links on the house's items.
  - Workbench route `/annotate/:photoId` (same ids as before, because the copy preserves them).

- [ ] **Step 1: Write the failing cutover tests**

```typescript
// api/test/photos-cutover.test.ts
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, itemLinks, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, writeTestJpeg } from "./fixtures";
import { addPhoto } from "../lib/photos";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, areaId, keuken, itemId };
}

describe("after the cutover, a filed object is visible everywhere", () => {
  it("inbox.fileObject writes a photo that items.listAll, items.get, photos.listAll and attachments.listForItem all show", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();

    const { itemId } = await callerFor(h1).inbox.fileObject({
      id: capId, label: "mug", xPct: 50, yPct: 50, wPct: 20, hPct: 20,
      itemId: null, itemName: "Mug", areaId, roomId: keuken,
    });

    const [photo] = await db.select().from(photos).where(eq(photos.itemId, itemId));
    expect([photo.sourceCaptureId, photo.cropBox]).toEqual([capId, { xPct: 50, yPct: 50, wPct: 20, hPct: 20 }]);
    const listed = await callerFor(h1).items.listAll({});
    expect(listed.find((i) => i.id === itemId)?.imageKey).toBe(photo.storageKey);
    const detail = await callerFor(h1).items.get({ id: itemId });
    expect(detail?.photos.map((p) => p.id)).toEqual([photo.id]);
    expect(detail?.links).toEqual([]);
    expect(detail?.attachments.map((a) => [a.id, a.kind])).toEqual([[photo.id, "image"]]);
    const catalog = await callerFor(h1).photos.listAll();
    expect(catalog.filter((r) => r.source === "photo").map((r) => r.id)).toEqual([photo.id]);
    expect(catalog.some((r) => r.source === "capture" && r.id === capId)).toBe(false);
    expect((await callerFor(h1).attachments.listForItem({ itemId })).map((a) => [a.id, a.kind])).toEqual([[photo.id, "image"]]);
  });
});

describe("inbox.acceptMany after the cutover", () => {
  it("an image capture gives the new item its own photo copy; a note capture an item_link; both remember the capture", async () => {
    const { db, h1, areaId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: imgCap }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const [{ id: noteCap }] = await db.insert(captures).values({ kind: "note", rawText: "a lamp with a broken switch" }).$returningId();

    await callerFor(h1).inbox.acceptMany({ id: imgCap, items: [{ areaId, itemId: null, itemName: "Lamp" }] });
    await callerFor(h1).inbox.acceptMany({ id: noteCap, items: [{ areaId, itemId: null, itemName: "Idea" }] });

    const [lamp] = await db.select().from(items).where(eq(items.name, "Lamp"));
    const [idea] = await db.select().from(items).where(eq(items.name, "Idea"));
    const [photo] = await db.select().from(photos).where(eq(photos.itemId, lamp.id));
    expect(photo.storageKey).not.toBe(capKey);
    expect(photo.sourceCaptureId).toBe(imgCap);
    const [note] = await db.select().from(itemLinks).where(eq(itemLinks.itemId, idea.id));
    expect([note.kind, note.content, note.sourceCaptureId]).toEqual(["note", "a lamp with a broken switch", noteCap]);
    expect(await db.select().from(photos).where(eq(photos.itemId, idea.id))).toHaveLength(0);
  });

  it("stays all-or-nothing: a capture whose file is gone files no item at all", async () => {
    const { db, h1, areaId } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-gone.jpg" }).$returningId();
    await expect(
      callerFor(h1).inbox.acceptMany({
        id: capId,
        items: [
          { areaId, itemId: null, itemName: "One" },
          { areaId, itemId: null, itemName: "Two" },
        ],
      }),
    ).rejects.toThrow();
    expect(await db.select().from(items)).toHaveLength(1); // only the seeded "pan"
    expect(await db.select().from(photos)).toHaveLength(0);
  });
});

describe("inbox.mergeDuplicates after the cutover", () => {
  it("keeps (dismisses) a duplicate capture that a photo or an item_link was made from, and deletes the rest", async () => {
    const { db, h1 } = await seed();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [{ id }] = await db
        .insert(captures)
        .values({ kind: "image", storageKey: await writeTestJpeg(), contentHash: "same", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })
        .$returningId();
      ids.push(id);
    }
    await db.insert(photos).values({ storageKey: "local/test-fake-merge-photo.jpg", sourceCaptureId: ids[1] });
    await db.insert(itemLinks).values({ kind: "file", storageKey: "local/test-fake-merge-file.pdf", sourceCaptureId: ids[2] });

    expect(await callerFor(h1).inbox.mergeDuplicates()).toEqual({ merged: 1, skipped: 2 });
    const left = await db.select().from(captures);
    expect(new Map(left.map((c) => [c.id, c.status]))).toEqual(
      new Map([
        [ids[0], "pending"],
        [ids[1], "dismissed"],
        [ids[2], "dismissed"],
      ]),
    );
  });
});

describe("items.remove after the cutover (deleteItemTx)", () => {
  it("items.remove removes photos, pins on them, links and their files; unlinks pins elsewhere; keeps a file a capture uses", async () => {
    const { db, h1, itemId } = await seed();
    const photoKey = await writeTestJpeg();
    const fileKey = await writeTestJpeg();
    const sharedKey = await writeTestJpeg();
    const [{ id: own }] = await db.insert(photos).values({ itemId, storageKey: photoKey }).$returningId();
    await db.insert(photos).values({ itemId, storageKey: sharedKey });
    await db.insert(captures).values({ kind: "image", storageKey: sharedKey });
    const [{ id: other }] = await db.insert(photos).values({ storageKey: "local/test-fake-wall.jpg" }).$returningId();
    await db.insert(photoPins).values([
      { photoId: own, xPct: 1, yPct: 1, label: "drawn on the pan's own photo" },
      { photoId: other, xPct: 2, yPct: 2, label: "pan", itemId },
    ]);
    await db.insert(itemLinks).values([
      { itemId, kind: "note", content: "n" },
      { itemId, kind: "file", storageKey: fileKey },
    ]);

    expect(await callerFor(h1).items.remove({ id: itemId })).toEqual({ ok: true });

    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([other]);
    expect(await db.select().from(itemLinks)).toHaveLength(0);
    expect((await db.select().from(photoPins)).map((p) => [p.photoId, p.itemId])).toEqual([[other, null]]);
    expect([photoKey, fileKey, sharedKey].map((k) => fs.existsSync(keyPath(k)))).toEqual([false, false, true]);
  });
});

describe("rooms after the cutover", () => {
  it("rooms.remove clears roomId on that room's location photos", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id: photoId }] = await db.insert(photos).values({ roomId: keuken, storageKey: "local/test-fake-room.jpg" }).$returningId();
    await callerFor(h1).rooms.remove({ id: keuken, force: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect(row.roomId).toBeNull();
  });
});

describe("deprecated attachments.* aliases", () => {
  it("never confuse a photo and a link that share a numeric id", async () => {
    const { db, h1, itemId } = await seed();
    await db.insert(photos).values({ id: 7, itemId, storageKey: "local/test-fake-seven.jpg" });
    await db.insert(itemLinks).values({ id: 7, itemId, kind: "note", content: "seven" });

    const listed = await callerFor(h1).attachments.listForItem({ itemId });
    expect(listed.map((a) => [a.id, a.kind]).sort()).toEqual([[-7, "note"], [7, "image"]]);
    await callerFor(h1).attachments.remove({ id: -7 });
    expect(await db.select().from(itemLinks)).toHaveLength(0);
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([7]);
  });

  it("attachments.unlink puts a photo back in the pool and refuses a negative id", async () => {
    const { db, h1, itemId, areaId, keuken } = await seed();
    const photo = await addPhoto(db, { itemId, areaId, storageKey: "local/test-fake-unlink-alias.jpg" });

    expect(await callerFor(h1).attachments.unlink({ id: photo.id })).toEqual({ ok: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, photo.id));
    expect(row.itemId).toBeNull();
    expect(row.roomId).toBe(keuken);
    await expect(callerFor(h1).attachments.unlink({ id: -1 })).rejects.toThrow(/Only a photo/);
  });

  it("add routes images to photos and the rest to item_links; url, listAllImages and remove keep their shapes", async () => {
    const { db, h1, itemId, areaId } = await seed();
    const key = await writeTestJpeg();
    const img = await callerFor(h1).attachments.add({ itemId, areaId, kind: "image", storageKey: key, fileName: "a.jpg" });
    const link = await callerFor(h1).attachments.add({ itemId, areaId, kind: "link", url: "https://example.com", title: "Manual" });
    expect(img).toEqual({ id: expect.any(Number), storageKey: key });
    expect(img.id).toBeGreaterThan(0);
    expect(link.id).toBeLessThan(0);
    expect((await db.select().from(itemLinks)).map((l) => [-l.id, l.url])).toEqual([[link.id, "https://example.com"]]);
    await expect(callerFor(h1).attachments.add({ itemId, kind: "image" })).rejects.toThrow(/storageKey/);

    expect((await callerFor(h1).attachments.listAllImages()).map((r) => [r.source, r.id])).toEqual([["attachment", img.id]]);
    expect(await callerFor(h1).attachments.url({ key })).toEqual({ url: expect.stringMatching(/^\/uploads\/test-/) });
    await callerFor(h1).attachments.remove({ id: img.id });
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });
});
```

- [ ] **Step 2: Point the existing tests at the new tables**

`api/test/houses.test.ts`: in the import on line 2 replace `attachments` with `photos`, and replace lines 19-20 with:

```typescript
    await db.insert(photos).values({ itemId, areaId, storageKey: "local/test-fake-a.jpg" });
    await db.insert(photos).values({ roomId, storageKey: "local/test-fake-b.jpg" });
```

`api/test/rooms.test.ts`: in the import on line 4 replace `attachments` with `photos`, and replace line 85 with:

```typescript
    await db.insert(photos).values({ roomId: zolder, title: "photo", storageKey: "local/test-fake-merge.jpg" });
```

`api/test/items-location.test.ts`: delete the whole `describe("attachments.unlink / map.photosForLocation", ...)` block (lines 83-100 and the blank line after it). `photos.unlink` and `photos.forRoom` are covered in `photos-routers.test.ts`. Then change the remaining schema import line to:

```typescript
import { areas, houses, items, rooms } from "@db/schema";
```

`api/test/inbox-location.test.ts`: delete the whole `describe("map.ensureAttachmentForCapture", ...)` block (lines 42-57 and the blank line after it; `photos.ensureForCapture` is covered in `photos-routers.test.ts`), delete line 2 (`import { eq } from "drizzle-orm";`, now unused) and then change the remaining schema import line to:

```typescript
import { areas, captures, houses, items, rooms } from "@db/schema";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run api/test/photos-cutover.test.ts api/test/houses.test.ts api/test/rooms.test.ts`
Expected: FAIL. `fileObject` writes `attachments`, so `photos` stays empty; `items.get` has no `photos`; `attachments.listForItem` reads `attachments`; `houses.impact` returns `photoCount: 0`; `rooms.merge` returns `photosMoved: 0`; `items.remove` leaves photos behind; `mergeDuplicates` merges 3. The "stays all-or-nothing" test already passes (acceptMany was transactional before); it guards that the rewrite keeps `tx`.

- [ ] **Step 4: Legacy-shape helpers in `api/lib/photos.ts`**

Change the schema import to:

```typescript
import { areas, captures, itemLinks, items, photoPins, photos, type CropBox, type ItemLink, type Photo } from "@db/schema";
```

and append:

```typescript
/** One row in the pre-consolidation `attachments` shape, for the deprecated
 * attachments.* aliases, the wiki and the AI context. item_links ids are
 * NEGATED so a number never means both a photo and a link. */
export interface LegacyAttachment {
  id: number;
  itemId: number | null;
  areaId: number | null;
  roomId: number | null;
  kind: "image" | ItemLinkKind;
  title: string | null;
  content: string | null;
  url: string | null;
  storageKey: string | null;
  mimeType: string | null;
  size: number | null;
  sourceCaptureId: number | null;
  cropBox: CropBox | null;
  createdAt: Date;
}

export function photoAsLegacy(p: Photo): LegacyAttachment {
  return {
    id: p.id,
    itemId: p.itemId,
    areaId: p.areaId,
    roomId: p.roomId,
    kind: "image",
    title: p.title,
    content: null,
    url: null,
    storageKey: p.storageKey,
    mimeType: p.mimeType,
    size: p.size,
    sourceCaptureId: p.sourceCaptureId,
    cropBox: p.cropBox ?? null,
    createdAt: p.createdAt,
  };
}

export function linkAsLegacy(l: ItemLink): LegacyAttachment {
  return {
    id: -l.id,
    itemId: l.itemId,
    areaId: l.areaId,
    roomId: null,
    kind: l.kind,
    title: l.title,
    content: l.content,
    url: l.url,
    storageKey: l.storageKey,
    mimeType: l.mimeType,
    size: l.size,
    sourceCaptureId: l.sourceCaptureId,
    cropBox: null,
    createdAt: l.createdAt,
  };
}

export async function legacyAttachmentsForItem(db: Db, itemId: number): Promise<LegacyAttachment[]> {
  const pics = await db.select().from(photos).where(eq(photos.itemId, itemId));
  const links = await db.select().from(itemLinks).where(eq(itemLinks.itemId, itemId));
  return [...pics.map(photoAsLegacy), ...links.map(linkAsLegacy)].sort(
    (a, b) => +b.createdAt - +a.createdAt || b.id - a.id,
  );
}
```

- [ ] **Step 5: `deleteItemTx` and `releaseStoredFiles` in `api/lib/entities.ts`**

Replace the import block (lines 1-12) with:

```typescript
import { eq, or, and, inArray } from "drizzle-orm";
import {
  items,
  photos,
  photoPins,
  itemLinks,
  relations,
  ideaItems,
  tasks,
  measurements,
  chatMessages,
  captures,
} from "@db/schema";
```

Replace `deleteItemTx` (lines 20-48) with:

```typescript
/**
 * Delete one item and everything that only makes sense with it, inside the
 * caller's transaction. Files are returned, not deleted, so the caller can
 * remove them after the transaction committed.
 */
export async function deleteItemTx(tx: Tx, id: number, opts: { summary?: string } = {}): Promise<string[]> {
  const item = await tx.query.items.findFirst({ where: eq(items.id, id) });
  const ownPhotos = await tx.select({ id: photos.id, storageKey: photos.storageKey }).from(photos).where(eq(photos.itemId, id));
  const ownLinks = await tx.select({ storageKey: itemLinks.storageKey }).from(itemLinks).where(eq(itemLinks.itemId, id));

  await tx.update(items).set({ parentId: null }).where(eq(items.parentId, id));
  await tx.delete(relations).where(or(eq(relations.fromItemId, id), eq(relations.toItemId, id)));
  // pins drawn ON this item's photos go with the photos; pins on other
  // photos that point AT this item only lose the link
  if (ownPhotos.length) await tx.delete(photoPins).where(inArray(photoPins.photoId, ownPhotos.map((p) => p.id)));
  await tx.update(photoPins).set({ itemId: null }).where(eq(photoPins.itemId, id));
  await tx.update(tasks).set({ itemId: null }).where(eq(tasks.itemId, id));
  await tx.delete(ideaItems).where(eq(ideaItems.itemId, id));
  await tx.delete(measurements).where(and(eq(measurements.targetType, "item"), eq(measurements.targetId, id)));
  await tx.delete(chatMessages).where(and(eq(chatMessages.scope, "item"), eq(chatMessages.scopeId, id)));
  await tx.delete(itemLinks).where(eq(itemLinks.itemId, id));
  await tx.delete(photos).where(eq(photos.itemId, id));
  await tx.delete(items).where(eq(items.id, id));
  await logEvent(
    {
      entityType: "item",
      entityId: id,
      action: "deleted",
      summary: opts.summary ?? `Item "${item?.name ?? id}" deleted`,
    },
    tx,
  );
  return [...ownPhotos.map((p) => p.storageKey), ...ownLinks.map((l) => l.storageKey)].filter((k): k is string => !!k);
}
```

In `releaseStoredFiles`, delete the first loop (the one over `attachments.storageKey`). After the copy, every key in the frozen `attachments` table is also held by a `photos` or `item_links` row, so checking it would only keep dead files.

- [ ] **Step 6: `api/routers/inbox.ts`**

Line 7 becomes:

```typescript
import { captures, areas, items, itemLinks, photos, rooms, type TriageSuggestion, type RoomGeometry } from "@db/schema";
```

and after line 17 (`import { setItemLocation } from "../lib/location";`) add:

```typescript
import { coverPhotos } from "../lib/photos";
```

In `detectObjects`, replace lines 351-358 (from `const photoRows = await db` through the closing `}` of the `for` loop that fills `photoByItem`) with:

```typescript
      const photoByItem = new Map([...(await coverPhotos(db))].map(([itemId, p]) => [itemId, p.storageKey] as const));
```

In `fileObject`, change the comment on line 498 to `// cutout: crop the box from the ORIGINAL snap and store it as a photo`, and replace the `await db.insert(attachments).values({ ... });` statement (lines 512-522) with:

```typescript
      await db.insert(photos).values({
        itemId,
        areaId: item?.areaId ?? input.areaId,
        title: `Cutout: ${input.label}`,
        storageKey: saved.key,
        mimeType: "image/jpeg",
        size: saved.size,
        sourceCaptureId: cap.id,
        cropBox: { xPct: input.xPct, yPct: input.yPct, wPct: input.wPct, hPct: input.hPct },
      });
```

In `acceptMany`, replace the block from `if (cap.rawText || cap.url || cap.storageKey) {` through its closing `}` (lines 590-615). It must keep using `tx`, so filing stays all-or-nothing:

```typescript
            if (cap.rawText || cap.url || cap.storageKey) {
              // the item gets its own copy of the file: a capture and a
              // photo/link must never share one storage key (deleting one
              // would delete the other's bytes)
              const copy = cap.storageKey
                ? await copyStoredFile(cap.storageKey, `items/${itemId}/${cap.storageKey.split("/").pop() ?? "photo"}`)
                : null;
              if (cap.kind === "image" && copy) {
                await tx.insert(photos).values({
                  itemId,
                  areaId: it.areaId,
                  title: cap.url ?? it.itemName,
                  storageKey: copy.key,
                  size: copy.size,
                  sourceCaptureId: cap.id,
                });
              } else {
                await tx.insert(itemLinks).values({
                  itemId,
                  areaId: it.areaId,
                  kind: cap.kind === "link" ? "link" : copy ? "file" : "note",
                  title: cap.url ?? it.itemName,
                  content: cap.rawText ?? null,
                  url: cap.url ?? null,
                  storageKey: copy?.key ?? null,
                  size: copy?.size ?? null,
                  sourceCaptureId: cap.id,
                });
              }
            }
```

In `mergeDuplicates`, replace the `const pinned = new Set( ... );` statement (lines 803-812) with:

```typescript
    const pinned = new Set(
      [
        ...(await db.select({ c: photos.sourceCaptureId }).from(photos).where(inArray(photos.sourceCaptureId, allDupeIds))),
        ...(await db.select({ c: itemLinks.sourceCaptureId }).from(itemLinks).where(inArray(itemLinks.sourceCaptureId, allDupeIds))),
      ]
        .map((r) => r.c)
        .filter((id): id is number => id != null),
    );
```

Check: `grep -n "attachments" api/routers/inbox.ts` prints only comment text, no code.

- [ ] **Step 7: `api/routers/items.ts`**

Line 2 becomes `import { eq, desc, or, and, asc } from "drizzle-orm";` and line 6 becomes:

```typescript
import { areas, items, photos, itemLinks, relations, tasks, ideaItems, ideas, events, houses, ITEM_DECISIONS, type ItemPos } from "@db/schema";
```

and after line 10 add `import { coverPhotos } from "../lib/photos";` (Step 7 below extends it).

In `listByArea`, replace lines 43-51 (from `const atts = await db` through the `return rows.map(...)`) with:

```typescript
      const covers = await coverPhotos(db, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, imageKey: covers.get(r.id)?.storageKey ?? null }));
```

In `listAll`, replace lines 80-85 (`const ids = ...` through the `for (const a of atts) ...` line) with:

```typescript
      const covers = await coverPhotos(db, rows.map((r) => r.id));
```

and in the returned object replace `imageKey: imgMap.get(r.id) ?? null,` with `imageKey: covers.get(r.id)?.storageKey ?? null,`.

In `get`, replace lines 104-108 (`const atts = await db ... .orderBy(desc(attachments.createdAt));`) with:

```typescript
    const itemPhotos = await db.select().from(photos).where(eq(photos.itemId, item.id)).orderBy(desc(photos.createdAt));
    const itemLinkRows = await db.select().from(itemLinks).where(eq(itemLinks.itemId, item.id)).orderBy(desc(itemLinks.createdAt));
```

and in its return object replace `attachments: atts,` (line 156) with:

```typescript
      photos: itemPhotos,
      links: itemLinkRows,
      attachments: [...itemPhotos.map(photoAsLegacy), ...itemLinkRows.map(linkAsLegacy)].sort((a, b) => +b.createdAt - +a.createdAt || b.id - a.id), // DEPRECATED alias field for external callers; link ids are negated
```

and extend the `../lib/photos` import added above to `import { coverPhotos, linkAsLegacy, photoAsLegacy } from "../lib/photos";`.

(The local `links` variable further down in `get` holds `ideaItems` rows; it is a different name from the `links` return key and stays as it is.)

- [ ] **Step 8: `rooms.ts`, `houses.ts`, `wiki.ts`, `ai.ts`**

`api/routers/rooms.ts` and `api/routers/houses.ts` use the table name only in the import, in `roomId` moves and in the house photo count, so a plain rename is exact:

```bash
sed -i '' 's/attachments/photos/g' api/routers/rooms.ts api/routers/houses.ts
grep -n "attachments" api/routers/rooms.ts api/routers/houses.ts
```

Expected: the `grep` prints nothing. The renamed lines are `rooms.ts` 6, 237, 238, 363, 384 and `houses.ts` 6, 10 (comment), 15, 16, 19, 140, 183. `rooms.merge` still returns `photosMoved` and `houses.impact` `photoCount`; they now count photos only.

`api/routers/wiki.ts`: line 6 becomes

```typescript
import { areas, items, itemLinks, photos, relations, wikiPages, type Area, type Item } from "@db/schema";
import { linkAsLegacy, photoAsLegacy } from "../lib/photos";
```

and line 45 (`const allAtts = await db.select().from(attachments);`) becomes

```typescript
  const allAtts = [
    ...(await db.select().from(photos)).map(photoAsLegacy),
    ...(await db.select().from(itemLinks)).map(linkAsLegacy),
  ];
```

`api/routers/ai.ts`: line 6 becomes

```typescript
import { areas, items, chatMessages } from "@db/schema";
import { legacyAttachmentsForItem } from "../lib/photos";
```

and line 17 becomes `    const atts = await legacyAttachmentsForItem(db, item.id);`.

- [ ] **Step 9: The deprecated aliases, and remove the old routers**

Replace the whole of `api/routers/attachments.ts` with:

```typescript
// api/routers/attachments.ts
// DEPRECATED aliases, kept for one release (AGENTS.md section 2). Flow
// (src/flow/ui.tsx) and the Computer Lab adapter call attachments.url/add/
// remove/unlink/listAllImages/listForItem; their inputs and outputs are unchanged.
// Storage moved to photos (images) and item_links (link/note/file). Rows from
// item_links carry a NEGATED id so a number never means both a photo and a
// link; pass ids back to attachments.remove exactly as received.
// New code calls photos.*, itemLinks.* and pins.*.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { urlForKey } from "../lib/filestore";
import { addItemLink, addPhoto, legacyAttachmentsForItem, listPhotoCatalog, removeItemLink, removePhoto, unlinkPhoto } from "../lib/photos";

export const attachmentsRouter = createRouter({
  add: procedure
    .input(
      z.object({
        itemId: z.number().optional(),
        areaId: z.number().optional(),
        kind: z.enum(["image", "link", "note", "file"]),
        title: z.string().optional(),
        content: z.string().optional(),
        url: z.string().optional(),
        fileName: z.string().optional(),
        /** key returned by POST /api/upload */
        storageKey: z.string().startsWith("local/").optional(),
        mimeType: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ id: number; storageKey: string | null }> => {
      const db = getDb();
      if (input.kind === "image") {
        if (!input.storageKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "An image needs a storageKey from POST /api/upload." });
        }
        return addPhoto(db, {
          itemId: input.itemId,
          areaId: input.areaId,
          title: input.title,
          storageKey: input.storageKey,
          fileName: input.fileName,
        });
      }
      const link = await addItemLink(db, { ...input, kind: input.kind });
      return { id: -link.id, storageKey: link.storageKey };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(({ input }) => {
    const db = getDb();
    return input.id < 0 ? removeItemLink(db, -input.id) : removePhoto(db, input.id);
  }),

  unlink: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    if (input.id < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a photo can be unlinked; remove a link or note with attachments.remove." });
    return unlinkPhoto(getDb(), input.id);
  }),

  url: procedure.input(z.object({ key: z.string() })).query(async ({ input }) => ({ url: await urlForKey(input.key) })),

  listForItem: procedure.input(z.object({ itemId: z.number() })).query(({ input }) => legacyAttachmentsForItem(getDb(), input.itemId)),

  listAllImages: procedure.query(async () =>
    (await listPhotoCatalog(getDb())).map((r) => ({ ...r, source: r.source === "photo" ? ("attachment" as const) : ("capture" as const) })),
  ),
});
```

Delete the replaced routers and unmount them:

```bash
git rm api/routers/annotations.ts api/routers/map.ts
```

In `api/router.ts` delete the lines `import { annotationsRouter } from "./routers/annotations";`, `import { mapRouter } from "./routers/map";`, `  annotations: annotationsRouter,` and `  map: mapRouter,`.

- [ ] **Step 10: `scripts/batch-detect-local.mjs` files cutouts as photos**

```bash
sed -i '' -e 's/db\.insert(schema\.attachments)/db.insert(schema.photos)/' -e '/^        kind: "image",$/d' scripts/batch-detect-local.mjs
grep -n 'schema\.photos\|kind: "image"' scripts/batch-detect-local.mjs
```

Expected: two `db.insert(schema.photos)` lines and no `kind: "image"` line (the script had exactly two, both inside these inserts).

- [ ] **Step 11: Run the server tests**

Run: `npx vitest run api/test/photos-cutover.test.ts api/test/houses.test.ts api/test/rooms.test.ts api/test/items-location.test.ts api/test/inbox-location.test.ts api/test/photos-routers.test.ts`
Expected: PASS. `npm run check` still fails at this point, only in `src/pages` and `src/components` (the next steps). If anything under `src/flow/` errors, stop: a Flow contract broke.

- [ ] **Step 12: `src/pages/ItemDetail.tsx`**

Replace `SourceLink`'s signature and query (lines 40-41):

```tsx
function SourceLink({ photoId }: { photoId: number }) {
  const source = trpc.photos.sourcePhoto.useQuery({ photoId });
```

Replace the three mutations `addAttachment`, `removeAttachment` and `unlinkAttachment` (lines 197-207) with:

```tsx
  const attachmentAdded = {
    onSuccess: () => {
      setNewNote("");
      setNewLink("");
      setUploadError(null);
      invalidate();
    },
    onError: (e: { message: string }) => setUploadError(e.message),
  };
  const addPhoto = trpc.photos.add.useMutation(attachmentAdded);
  const addLink = trpc.itemLinks.add.useMutation(attachmentAdded);
  const addingAttachment = addPhoto.isPending || addLink.isPending;
  const removeLink = trpc.itemLinks.remove.useMutation({ onSuccess: invalidate });
  const unlinkPhoto = trpc.photos.unlink.useMutation({ onSuccess: invalidate });
```

Replace `uploadAttachment` (lines 278-294) with:

```tsx
  const uploadAttachment = async (f: File) => {
    setUploadError(null);
    try {
      const up = await uploadFile(f, "attachments");
      if (up.mimeType.startsWith("image/")) {
        addPhoto.mutate({ itemId, areaId: it.areaId, title: f.name, fileName: up.fileName, storageKey: up.key });
      } else {
        addLink.mutate({ itemId, areaId: it.areaId, kind: "file", title: f.name, fileName: up.fileName, storageKey: up.key, mimeType: up.mimeType });
      }
    } catch (e) {
      setUploadError((e as Error).message);
    }
  };
```

Directly after `const confirmed = it.relations.filter((r) => r.status === "confirmed");` add:

```tsx
  // photos and links/notes/files live in two tables now; the list shows
  // them together, newest first, as it always did
  const entries = [
    ...it.photos.map((p) => ({
      entry: "photo" as const,
      id: p.id,
      kind: "image" as const,
      title: p.title,
      content: null,
      url: null,
      storageKey: p.storageKey as string | null,
      sourceCaptureId: p.sourceCaptureId,
      createdAt: p.createdAt,
    })),
    ...it.links.map((l) => ({
      entry: "link" as const,
      id: l.id,
      kind: l.kind,
      title: l.title,
      content: l.content,
      url: l.url,
      storageKey: l.storageKey,
      sourceCaptureId: l.sourceCaptureId,
      createdAt: l.createdAt,
    })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
```

Then apply the remaining renames in this file:

```bash
sed -i '' \
  -e 's/addAttachment\.mutate(/addLink.mutate(/g' \
  -e 's/addAttachment\.isPending/addingAttachment/g' \
  -e 's/{it\.attachments\.length === 0/{entries.length === 0/' \
  -e 's/{it\.attachments\.map((a) => (/{entries.map((a) => (/' \
  -e 's/<div key={a\.id} className="group flex items-start gap-2">/<div key={`${a.entry}-${a.id}`} className="group flex items-start gap-2">/' \
  -e 's/<SourceLink attachmentId={a\.id} \/>/<SourceLink photoId={a.id} \/>/' \
  -e 's/{a\.kind === "image" ? (/{a.entry === "photo" ? (/' \
  -e 's/unlinkAttachment/unlinkPhoto/g' \
  -e 's/removeAttachment/removeLink/g' \
  -e 's/<RecropDialog attachmentId={recropId}/<RecropDialog photoId={recropId}/' \
  -e 's/trpc\.annotations\.listForItem/trpc.pins.listForItem/' \
  -e 's/`\/annotate\/${p\.attachmentId}`/`\/annotate\/${p.photoId}`/' \
  -e 's/{p\.attachment?\.title ?? `photo #${p\.attachmentId}`}/{p.photo?.title ?? `photo #${p.photoId}`}/' \
  -e 's/trpc\.attachments\.url\.useQuery/trpc.photos.url.useQuery/' \
  src/pages/ItemDetail.tsx
grep -n "ttachment\|annotations" src/pages/ItemDetail.tsx
```

Expected `grep` output: only `AttachmentView` (the component name), `uploadAttachment`, `attachmentAdded`, `addingAttachment`, `uploadFile(f, "attachments")` (the upload folder scope, which stays) and the delete-item dialog's description text "its attachments, tasks, …" (user copy, unchanged).

- [ ] **Step 13: `src/pages/Annotate.tsx` and the route**

```bash
sed -i '' \
  -e 's/useParams<{ attachmentId: string }>/useParams<{ photoId: string }>/' \
  -e 's/const { attachmentId } = useParams/const { photoId } = useParams/' \
  -e 's/const attId = Number(attachmentId);/const attId = Number(photoId);/' \
  -e 's/trpc\.attachments\.urlForAttachment\.useQuery({ attachmentId: attId })/trpc.photos.get.useQuery({ id: attId })/' \
  -e 's/trpc\.annotations\.listForAttachment/trpc.pins.listForPhoto/' \
  -e 's/utils\.annotations\.listForAttachment/utils.pins.listForPhoto/' \
  -e 's/trpc\.annotations\./trpc.pins./g' \
  -e 's/utils\.annotations\./utils.pins./g' \
  -e 's/trpc\.attachments\.createCutoutFromAttachment/trpc.photos.createCutout/' \
  -e 's/utils\.attachments\.listForItem/utils.photos.listForItem/' \
  -e 's/sourceAttachmentId: attId/sourcePhotoId: attId/' \
  -e 's/attachmentId: attId/photoId: attId/g' \
  -e 's/p\.attachmentId/p.photoId/g' \
  src/pages/Annotate.tsx
sed -i '' 's|<Route path="/annotate/:attachmentId"|<Route path="/annotate/:photoId"|' src/App.tsx
grep -n "ttachment\|annotations" src/pages/Annotate.tsx src/App.tsx
```

Expected `grep` output: only lines containing `currentAttachmentId`, a local prop name of `LinkedItemChip` and `SuggestedPinRow` that carries the photo id. It is left as it is to keep this diff to the API.

- [ ] **Step 14: The remaining Workbench call sites**

```bash
# Photos catalog: new procedure names, `source` is "photo" | "capture"
sed -i '' \
  -e 's/trpc\.map\.ensureAttachmentForCapture/trpc.photos.ensureForCapture/' \
  -e 's/res\.attachmentId/res.photoId/' \
  -e 's/trpc\.attachments\.listAllImages/trpc.photos.listAll/' \
  -e 's/  source: "attachment" | "capture";/  source: "photo" | "capture";/' \
  src/pages/Photos.tsx

# Map, Inbox: photo pool, pin-this-photo, thumbnails
sed -i '' \
  -e 's/trpc\.map\.photosForLocation/trpc.photos.forRoom/' \
  -e 's/trpc\.map\.ensureAttachmentForCapture/trpc.photos.ensureForCapture/g' \
  -e 's/res\.attachmentId/res.photoId/g' \
  -e 's/trpc\.attachments\.url\.useQuery/trpc.photos.url.useQuery/g' \
  src/pages/Map.tsx src/pages/Inbox.tsx

# Choose-from-library dialog
sed -i '' \
  -e 's/sourceAttachmentId/sourcePhotoId/g' \
  -e 's/setSourceAttachmentId/setSourcePhotoId/g' \
  -e 's/trpc\.map\.ensureAttachmentForCapture/trpc.photos.ensureForCapture/' \
  -e 's/trpc\.attachments\.urlForAttachment/trpc.photos.get/' \
  -e 's/{ attachmentId: sourcePhotoId ?? 0 }/{ id: sourcePhotoId ?? 0 }/' \
  -e 's/trpc\.attachments\.createCutoutFromAttachment/trpc.photos.createCutout/' \
  -e 's/utils\.attachments\.listForItem/utils.photos.listForItem/' \
  -e 's/res\.attachmentId/res.photoId/' \
  -e 's/trpc\.attachments\.url\.useQuery/trpc.photos.url.useQuery/' \
  src/components/ChooseFromLibraryDialog.tsx

# Re-crop dialog: prop and procedures
sed -i '' \
  -e 's/attachmentId/photoId/g' \
  -e 's/trpc\.attachments\.sourcePhoto/trpc.photos.sourcePhoto/' \
  -e 's/trpc\.attachments\.recrop/trpc.photos.recrop/' \
  -e 's/utils\.attachments\.listForItem/utils.photos.listForItem/' \
  -e 's/utils\.attachments\.urlForAttachment/utils.photos.get/' \
  src/components/RecropDialog.tsx

# thumbnails: the Workbench stops using the deprecated alias (GeojsonThumb is
# shared with Flow; only its internal query changes, its props do not)
sed -i '' 's/trpc\.attachments\.url\.useQuery/trpc.photos.url.useQuery/g' \
  src/components/Thumb.tsx src/components/GeojsonThumb.tsx src/components/DetectObjects.tsx
```

In `src/pages/Activity.tsx` line 6 add the new event types (keep `"attachment"` for history):

```tsx
const ENTITY_TYPES = ["all", "item", "area", "task", "idea", "capture", "photo", "item_link", "pin", "attachment", "relation", "wiki", "chat"];
```

In `src/pages/Map.tsx`, replace the comment above `PhotoCard` (lines 126-131) with:

```tsx
/**
 * One photo in the pool. The pool is keyed by *capture* id (the original
 * source photo), but the pin canvas at /annotate works on a *photo* id - a
 * capture isn't pinnable until it also has a photo. Make one on demand
 * (find-or-create, so repeat visits reuse the same row) before navigating in.
 */
```

- [ ] **Step 15: Confirm no old name is left**

```bash
grep -rnE "trpc\.(annotations|map)\.|utils\.(annotations|map)\.|urlForAttachment|createCutoutFromAttachment|ensureAttachmentForCapture|photosForLocation|sourceAttachmentId|listAllImages|res\.attachmentId|p\.attachmentId|it\.attachments" src
grep -rn "trpc\.attachments\.\|utils\.attachments\." src
grep -rnE "from\(attachments\)|attachments\.(id|kind|itemId|roomId|storageKey|sourceCaptureId)|photoAnnotations|schema\.attachments" api scripts db --include='*.ts' --include='*.mjs'
```

Expected: the first command prints nothing. The second prints exactly `src/flow/ui.tsx:10`, the Flow call on the deprecated alias, which must stay. The third prints only `db/schema.ts` (the table definitions, dropped in Task 5) and `api/test/copy-attachments.test.ts` (deleted in Task 5).

- [ ] **Step 16: Docs**

In `AGENTS.md` §2, in the tRPC bullet replace `` `attachments.url`, `rooms.get`. `` with `` `attachments.url` (deprecated alias of `photos.url`), `rooms.get`. `` and add this bullet directly below the tRPC bullet:

```markdown
- Photos (since the photos consolidation): `photos.url`, `photos.listAll`, `photos.listForItem`, `photos.add`, `photos.remove`, `photos.unlink`, `itemLinks.add`, `itemLinks.remove`, `itemLinks.listForItem`. Deprecated aliases, kept for one release with unchanged inputs and outputs: `attachments.url`, `attachments.add`, `attachments.remove`, `attachments.unlink`, `attachments.listAllImages`, `attachments.listForItem`. They return `item_links` rows with a negated id, and `items.get` still carries a deprecated `attachments` array in the same shape next to `photos` and `links`; pass ids back to `attachments.remove` unchanged; `attachments.unlink` accepts photo ids only. New callers use the `photos.*` and `itemLinks.*` names.
```

In `README.md` line 41, replace `` `/annotate/:attachmentId` `` with `` `/annotate/:photoId` ``.

- [ ] **Step 17: Full verification, then a click-through against the test database**

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean, with no errors under `src/flow/`.

Then start the dev server **against the test database**. Never run `npm run dev` in this worktree with the default `.env`: its `DATABASE_URL` is production, which has no `photos` table until Task 6.

```bash
TEST_URL="$(node -e 'require("dotenv").config(); process.stdout.write(process.env.TEST_DATABASE_URL)')"
DATABASE_URL="$TEST_URL" npx vite --port 3002
```

In the browser at `http://localhost:3002/`: add a house and a topic, create an item, and on the item page upload a JPEG (it shows as a photo with an Annotate link), add a note and a link (they show in the same list). Open Annotate on the photo, add a pin linked to the item, go back: "Seen in photos" lists it. Unlink the photo (it disappears from the item and appears on `/photos`), then delete the note. Stop the server. Every action must succeed without a red error toast or a 500 in the terminal. `npm test` truncates this database again, so nothing needs cleaning up.

- [ ] **Step 18: Commit**

```bash
git add -A api scripts src AGENTS.md README.md
git commit -m "Cutover: every reader and writer moves to photos/item_links/photo_pins in one commit

Inbox filing (fileObject, transactional acceptMany), reference photos,
mergeDuplicates, item covers, items.get, item deletion and file release,
room and house moves, wiki and AI context, the batch detector and every
Workbench call site switch together, so no commit files photos where no
screen looks. attachments.url/add/remove/listAllImages/listForItem stay as
deprecated aliases with unchanged shapes for Flow and the Computer Lab
adapter (item_links ids negated so ids are never ambiguous); annotations.*
and map's photo procedures are replaced by pins.* and photos.*."
```

---

### Task 5: Schema step B: drop `attachments` and `photo_annotations`

**Files:**
- Modify: `db/schema.ts` (remove the `attachments` table and its comment block, lines 162-191; the `photoAnnotations` table and its comment block, lines 311-335; the `Attachment` and `PhotoAnnotation` types)
- Create: `db/migrations/0006_drop_attachments.sql`, `db/migrations/meta/0006_snapshot.json` (generated), `meta/_journal.json` (generated update)
- Delete: `api/test/copy-attachments.test.ts` (its subject tables no longer exist in the schema; Task 2 proved the behaviour and Task 6 logs the production run, the same call the rooms plan made for its backfill test)
- Modify: `api/lib/copyAttachmentsToPhotos.ts`, `scripts/copy-attachments-to-photos.mjs` (a HISTORICAL header line)
- Test: `api/test/photos-schema.test.ts`

**Warning:** once 0006 is applied to `declutter_test`, any other worktree still on the old schema fails `npm test` at `TRUNCATE attachments` until it rebases onto this branch. Tell Rick and the declutter-flow session before running Task 5 Step 6.

**Interfaces:**
- Consumes: Task 4's guarantee that no code path reads or writes `attachments` or `photo_annotations`.
- Produces: migration tag `0006_drop_attachments` (exactly two `DROP TABLE` statements). `@db/schema` no longer exports `attachments`, `photoAnnotations`, `Attachment` or `PhotoAnnotation`. The `attachments` *router* stays (the deprecated aliases). It reads no table of that name.

- [ ] **Step 1: Write the failing test**

In `api/test/photos-schema.test.ts` change the drizzle import to `import { eq, sql } from "drizzle-orm";` and add inside `describe("photos schema", ...)`:

```typescript
  it("has no attachments or photo_annotations table any more", async () => {
    const db = getTestDb();
    const [rows] = await db.execute(
      sql`select table_name as t from information_schema.tables where table_schema = database() and table_name in ('attachments', 'photo_annotations')`,
    );
    expect(rows).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run api/test/photos-schema.test.ts`
Expected: FAIL. `rows` lists both tables.

- [ ] **Step 3: Confirm nothing reads the old tables**

```bash
grep -rnE "from\(attachments\)|attachments\.(id|kind|itemId|roomId|storageKey|sourceCaptureId)|photoAnnotations|schema\.attachments|type Attachment =|PhotoAnnotation" api src scripts db --include='*.ts' --include='*.tsx' --include='*.mjs'
```

Expected: hits only in `db/schema.ts` and `api/test/copy-attachments.test.ts`. Anything else is a leftover from Task 4: fix it before continuing. (Plain-SQL strings in `api/lib/copyAttachmentsToPhotos.ts` and the historical `scripts/backfill-rooms.mjs` do not match and are expected to stay.)

- [ ] **Step 4: Remove the tables from the schema and generate the migration**

In `db/schema.ts` delete:
- the block from the comment line `// Attachments — images / files (storageKey), links (url), notes (content)` (with the `// ----` rule above and below it) through the closing `);` of `export const attachments = mysqlTable(...)`;
- the block from the comment line `// Photo annotations — pins on image attachments, linked to items` (with its rules) through the closing `);` of `export const photoAnnotations = mysqlTable(...)`;
- the lines `export type Attachment = typeof attachments.$inferSelect;` and `export type PhotoAnnotation = typeof photoAnnotations.$inferSelect;`.

Keep `CropBox` (used by `photos`).

```bash
git rm api/test/copy-attachments.test.ts
npm run db:generate -- --name drop_attachments
cat db/migrations/0006_drop_attachments.sql
```

Expected: exactly `DROP TABLE \`attachments\`;` and `DROP TABLE \`photo_annotations\`;` (with a `--> statement-breakpoint` between them), nothing else. drizzle-kit asks no rename question, because no table is being added.

- [ ] **Step 5: Mark the copy as historical**

Make this the first line of `api/lib/copyAttachmentsToPhotos.ts` and of `scripts/copy-attachments-to-photos.mjs`:

```typescript
// HISTORICAL after migration 0006: reads attachments/photo_annotations, which 0006 drops. Run only between 0005 and 0006 (photos consolidation plan, Task 6).
```

- [ ] **Step 6: Run the test to verify it passes, then everything**

Run: `npx vitest run api/test/photos-schema.test.ts`
Expected: PASS, 4 tests (globalSetup applies 0006 to the test database).

Run: `npm run check && npx eslint api src && npm test && npm run build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add -A db/schema.ts db/migrations api/test/photos-schema.test.ts api/test/copy-attachments.test.ts api/lib/copyAttachmentsToPhotos.ts scripts/copy-attachments-to-photos.mjs
git commit -m "Drop attachments and photo_annotations; photos, item_links and photo_pins are the only picture tables

Schema step B. Applied in production only after the copy is verified and the
new server runs (Task 6), with Rick's go. The attachments router stays as
deprecated aliases over the new tables."
```

---

### Task 6: Production rollout

**Files:** none in the code. Operations, then notes appended to this plan.

This follows the sequence the rooms rollout actually ran on 2026-10-02 (see "Rollout executed" in `2026-10-02-rooms-consolidation.md`): back up with `node db/backup.mjs`, apply the additive migration alone from a worktree pinned at its commit, move the data, `npm run build` and restart the server on port 3001, then drop. One change: here the server is **stopped before the copy** and started on the new build right after it, so no request can write to `attachments` once the copy has read it (finding #28). Expect a few minutes of downtime. Telegram messages queue on Telegram's side and are picked up when the bot restarts.

`db:adopt` already ran during the rooms rollout (`__drizzle_migrations` has the rows for 0002 (adopted), 0003 and 0004). Do not run it again.

Shell variables do not survive between separate commands in an agent session. Each block below is meant to be run as one command, and values that later blocks need are written to `~/photos-rollout-*` files.

- [ ] **Step 0: Preconditions and Rick's go for the window**

- Tasks 1–5 are committed on `feat/photos-consolidation` and the whole-branch review is done.
- `npm test` passes in `/Volumes/T7/declutter-photos`.
- Re-run Task 1 Step 6's branch scan. No branch other than `feat/photos-consolidation` may have `0005_` or `0006_` files.
- Ask Rick, and wait for an explicit yes: "Photos rollout: about 5 minutes of downtime on :3001. The serving tree `/Volumes/T7/declutter` moves (detached) to the `feat/photos-consolidation` tip. The drop of `attachments`/`photo_annotations` is a separate yes, later. Also: old-code dev servers must not run against production after 0006. OK to start?"

- [ ] **Step 1: Back up**

```bash
cd /Volumes/T7/declutter && node db/backup.mjs ~/declutter-before-photos-$(date +%Y%m%d-%H%M).sql
```

Expected: `wrote /Users/ricktav/declutter-before-photos-….sql: N tables, M rows, K KB` with M in the same range as the rooms rollout (1,105 rows) or larger. Do not continue without this file.

- [ ] **Step 2: Read-only plan and a baseline from the running (old) server**

```bash
cd /Volumes/T7/declutter-photos && npm run db:copy-photos -- --plan; echo "exit $?"
```

Expected: `plan { images: …, links: …, pins: …, imagesWithoutFile: [], unknownKind: [], nonImageWithRoom: [], orphanPins: [...] }` and `exit 0`. Record the numbers. `orphanPins` may be non-empty: those are pins left behind by item deletions before this change, already invisible in the UI, and they are not copied. **If the exit code is 2**, stop and show Rick the blocking ids from the plan; continue only after his ruling (either fix the rows through the app first, or later pass `--accept-losses`).

Write the smoke script and take the baseline:

```bash
cat > ~/photos-smoke.mjs <<'JS'
// read-only smoke for the photos rollout: node ~/photos-smoke.mjs [--new]
const base = "http://localhost:3001/api/trpc/";
const headers = process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {};
async function q(path, input) {
  const url = base + path + (input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`);
  const r = await fetch(url, { headers });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.json;
}
const catalog = await q("attachments.listAllImages");
const all = await q("items.listAll", { includeArchived: true, houseId: null });
const out = {
  catalogRows: catalog.length,
  catalogFiled: catalog.filter((r) => r.source === "attachment").length,
  catalogInbox: catalog.filter((r) => r.source === "capture").length,
  items: all.length,
  itemsWithImage: all.filter((i) => i.imageKey).length,
};
if (process.argv.includes("--new")) {
  out.photosListAll = (await q("photos.listAll")).length;
  const sample = all.find((i) => i.imageKey);
  if (sample) {
    const detail = await q("items.get", { id: sample.id });
    out.sampleItemPhotosPlusLinks = detail.photos.length + detail.links.length;
    out.sampleItemLegacy = (await q("attachments.listForItem", { itemId: sample.id })).length;
  }
}
console.log(JSON.stringify(out));
JS
node ~/photos-smoke.mjs | tee ~/photos-rollout-before.json
```

Expected: one JSON line, e.g. `{"catalogRows":…,"catalogFiled":…,"catalogInbox":…,"items":…,"itemsWithImage":…}` with `catalogFiled` equal to the plan's `images`.

- [ ] **Step 3: Apply 0005 alone, from a worktree pinned at the Task 1 commit**

`drizzle-kit migrate` applies every pending journal entry, so at the branch tip it would apply 0005 and 0006 together. Apply 0005 from a checkout that does not have 0006 yet:

```bash
SCHEMA_A=$(git -C /Volumes/T7/declutter-photos log --format=%h -1 --grep='^Add photos, item_links and photo_pins tables')
echo "schema A commit: $SCHEMA_A"
git -C /Volumes/T7/declutter-photos worktree add --detach /Volumes/T7/declutter-photos-schema-a "$SCHEMA_A"
cp /Volumes/T7/declutter/.env /Volumes/T7/declutter-photos-schema-a/.env
ln -s /Volumes/T7/declutter/node_modules /Volumes/T7/declutter-photos-schema-a/node_modules
cd /Volumes/T7/declutter-photos-schema-a && ls db/migrations/*.sql && npm run db:migrate
```

Expected: the `ls` lists `0000_baseline.sql` through `0005_add_photos_tables.sql` and **no** `0006_…`; `db:migrate` succeeds. Then verify:

```bash
cd /Volumes/T7/declutter-photos-schema-a && node -e 'require("dotenv").config(); const m = require("mysql2/promise"); (async () => { const c = await m.createConnection({ uri: process.env.DATABASE_URL }); for (const q of ["select id, created_at from __drizzle_migrations order by created_at", "select (select count(*) from photos) photos, (select count(*) from item_links) item_links, (select count(*) from photo_pins) photo_pins, (select count(*) from attachments) attachments, (select count(*) from photo_annotations) photo_annotations"]) { const [r] = await c.query(q); console.table(r); } await c.end(); })()'
```

Expected: 4 rows in `__drizzle_migrations` (0002 adopted, 0003, 0004, 0005); `photos`, `item_links` and `photo_pins` are 0; `attachments` and `photo_annotations` are unchanged.

- [ ] **Step 4: Stop the production server**

First list every vite dev server and the worktree it runs in:

```bash
for p in $(pgrep -f 'node_modules/.bin/vite'); do echo "$p $(lsof -a -p $p -d cwd -Fn | sed -n 's/^n//p')"; done
```

Rick stops every dev server whose worktree `.env` has the production `DATABASE_URL` (on 2026-10-02: :3000 in /Volumes/T7/declutter and :3011 in /Volumes/T7/declutter-flow). A dev server on the old code writes `attachments` straight to production and would slip rows past the copy. Re-check with the same command after the copy (Step 5). Then:

```bash
git -C /Volumes/T7/declutter rev-parse --abbrev-ref HEAD > ~/photos-rollout-prev-ref
git -C /Volumes/T7/declutter rev-parse --short HEAD >> ~/photos-rollout-prev-ref
cat ~/photos-rollout-prev-ref   # expected: main, then e85167d
PID=$(pgrep -f 'node dist/boot.js'); echo "pid $PID"
echo "$(date -u +%FT%TZ) photos rollout: stopping pid $PID (serving $(tr '\n' ' ' < ~/photos-rollout-prev-ref))" >> ~/declutter-prod.log
kill "$PID"
```

Then run `pgrep -f 'node dist/boot.js' || echo stopped` until it prints `stopped`.

- [ ] **Step 5: Copy and verify**

```bash
cd /Volumes/T7/declutter-photos && npm run db:copy-photos -- --copy; echo "exit $?"
```

Expected: `copied { photosCreated: <plan.images>, itemLinksCreated: <plan.links>, pinsCreated: <plan.pins> }`, `verify { missingPhotos: 0, missingItemLinks: 0, missingPins: 0, mismatched: 0, ok: true }`, `exit 0`. Run the same command a second time: `copied` is all zeros, verify is still `ok: true`, exit 0.

If the exit code is 3, or anything throws: do not start the new build. Start the old server again (Rollback A below) and report to Rick. The copy runs in one transaction, so a failed run left nothing half-written.

After the copy, re-run the dev-server listing from Step 4. Anything that started in the meantime and points at the production `DATABASE_URL` is stopped before the new server starts.

- [ ] **Step 6: Build and start the new server**

```bash
cd /Volumes/T7/declutter && git status --short
```

Expected: no modified tracked files (untracked plan or notes files are fine). Then:

```bash
cd /Volumes/T7/declutter && git switch --detach feat/photos-consolidation \
  && git diff --stat "$(sed -n 2p ~/photos-rollout-prev-ref)"..HEAD -- package.json package-lock.json \
  && npm run build \
  && (PORT=3001 NODE_ENV=production nohup node dist/boot.js >> ~/declutter-prod.log 2>&1 &) \
  && echo "$(date -u +%FT%TZ) photos rollout: started new build at $(git rev-parse --short HEAD)" >> ~/declutter-prod.log
```

(`--detach`, because the branch is checked out in `/Volumes/T7/declutter-photos` and git refuses a branch that is checked out in two worktrees.) The `git diff --stat` must show only the `db:copy-photos` line in `package.json` and nothing in `package-lock.json`, so `npm ci` is not needed. Step 6 is the point where the serving tree leaves `main` for the branch tip. Then run `pgrep -f 'node dist/boot.js'` (note the new pid) and `tail -4 ~/declutter-prod.log`. Expected: `Server running on http://localhost:3001/` and `[telegram] inbox bot started`.

- [ ] **Step 7: Smoke the new server**

```bash
node ~/photos-smoke.mjs --new | tee ~/photos-rollout-after.json; cat ~/photos-rollout-before.json
```

Expected: `catalogRows`, `catalogFiled`, `catalogInbox`, `items` and `itemsWithImage` equal the baseline exactly; `photosListAll` equals `catalogRows`; `sampleItemLegacy` equals `sampleItemPhotosPlusLinks`. Any difference: stop and use Rollback A.

Ask Rick to click through in the browser: an item page with photos and a note; `/photos`; `/annotate/<a photo id>` with its pins; Map → a room's photo pool; Inbox → pin a photo. Check `tail ~/declutter-prod.log` for errors.

- [ ] **Step 8: Rick's explicit go, then apply 0006**

Ask Rick, and wait for an explicit yes: "Copy verified (photos …, item_links …, photo_pins …; verify ok), new server live since … (pid …), smoke equal to the baseline. OK to drop `attachments` and `photo_annotations` (migration 0006)? Backup: `~/declutter-before-photos-….sql`."

Then:

```bash
cd /Volumes/T7/declutter && npm run db:migrate
node -e 'require("dotenv").config(); const m = require("mysql2/promise"); (async () => { const c = await m.createConnection({ uri: process.env.DATABASE_URL }); for (const q of ["select count(*) n from __drizzle_migrations", "select table_name t from information_schema.tables where table_schema = database() and table_name in (\"attachments\", \"photo_annotations\", \"photos\", \"item_links\", \"photo_pins\") order by 1"]) { const [r] = await c.query(q); console.table(r); } await c.end(); })()'
node ~/photos-smoke.mjs --new
```

Expected: `__drizzle_migrations` has 5 rows; only `item_links`, `photo_pins` and `photos` are listed; the smoke line matches Step 7. No restart is needed (the running code never touches the dropped tables).

- [ ] **Step 9: Clean up**

```bash
rm /Volumes/T7/declutter-photos-schema-a/node_modules
git -C /Volumes/T7/declutter worktree remove /Volumes/T7/declutter-photos-schema-a
rm ~/photos-smoke.mjs
```

If `worktree remove` refuses because of the copied `.env`, use `--force`: it is a throwaway checkout of a committed SHA. Keep `~/photos-rollout-before.json`, `~/photos-rollout-after.json` and `~/photos-rollout-prev-ref` until the notes are committed.

- [ ] **Step 10: Record**

Append a section `## Rollout executed <date> <time window> (Task 6)` to this plan, in `/Volumes/T7/declutter-photos`. Include the backup file name and its `wrote …` line; the `--plan` output (including the `orphanPins` count); the schema-A SHA; both `--copy` outputs; the two smoke JSON lines; the old and new pids; the `__drizzle_migrations` row count after 0006. Then:

```bash
cd /Volumes/T7/declutter-photos && git add docs/superpowers/plans/2026-10-02-photos-consolidation.md \
  && git commit -m "Photos consolidation: production rollout notes" \
  && rm ~/photos-rollout-before.json ~/photos-rollout-after.json ~/photos-rollout-prev-ref
```

**Rollback A (any time before Step 8):** `attachments` and `photo_annotations` are untouched.
1. Stop the new server: `kill $(pgrep -f 'node dist/boot.js')`.
2. `cd /Volumes/T7/declutter && git switch "$(sed -n 1p ~/photos-rollout-prev-ref)"`. The serving tree starts the rollout on `main` (e85167d), which is what that file records, so this switches it back to `main`; if the file says `HEAD`, use `git switch --detach "$(sed -n 2p ~/photos-rollout-prev-ref)"`.
3. `npm run build`, then start the server the same way as in Step 6.

The new tables can stay (they are additive). Anything filed while the new server ran exists only in `photos`/`item_links`. List it with `select * from photos where id > (select max(id) from attachments)` and the same query for `item_links`, and tell Rick.

**Rollback B (after Step 8):** restore from the backup file. The Mac has no MySQL client, so restore on the DB host (10.50.0.10) or another machine that has one (`mysql declutter < declutter-before-photos-….sql`). Ask Rick before doing this.

---

## Self-Review

**1. Spec and pre-flight coverage.** Each pre-flight finding and ruling is resolved in this text:

| finding | where |
|---|---|
| #1 `attachments.url` has no replacement | `photos.url` (Task 3); `attachments.url` kept as alias (Task 4 Step 9); Workbench moved to `photos.url` (Task 4 Step 14); Flow untouched |
| #2 AGENTS.md §2 contract names | aliases keep unchanged I/O (Task 4 Step 9); §2 lists the new names and marks the aliases deprecated (Task 4 Step 16) |
| #3 plan edited `src/flow/` | nothing under `src/flow/` is edited (Global Constraints; Task 4 Step 15 expects `src/flow/ui.tsx:10` to remain) |
| #4 `items.get`/`imageKey` reshape | `items.get` returns `photos` + `links` (Task 4 Step 7); `imageKey` kept, now from `coverPhotos` (Task 4 Step 7); ItemDetail merges both lists (Task 4 Step 12) |
| #5 no `itemLinks.add/remove/listForItem` | `itemLinks` router (Task 3 Step 7) |
| #6 return-shape renames | `ensureForCapture → { photoId }`, `photos.get → { photo, url }`, pins carry `photoId`/`photo`; every consumer updated (Task 4 Steps 12–14) |
| #7 `listAll` row shape | `CatalogRow` with `source`, `areaName`, `isItemCover` (Task 3 Step 5; test in Step 2); `attachments.listAllImages` maps `source` back to `"attachment"` (Task 4 Step 9) |
| #8 ordering regressions | single cutover commit, option (a) (Design decisions; Task 4 intro) |
| #9 `inbox.ts:352`, `inbox.ts:806`, `annotations.ts:59-61,116,224,323` | Task 4 Step 6 (detect reference photos, mergeDuplicates); `pins.ts` (Task 3 Step 8) |
| #10 rooms/houses/wiki/ai/batch script/tests | Task 4 Steps 2, 8, 10 |
| #11 transactional `acceptMany`, `sourceCaptureId` on links | `tx.insert` kept, `item_links.sourceCaptureId` (Task 1, Task 4 Step 6; tests in Task 4 Step 1) |
| #12 `deleteItemTx` releases link file keys | Task 4 Step 5; test "items.remove removes photos, pins on them, links and their files" |
| #13 copy dedupe and null `storageKey` | id-keyed idempotency, explicit `imagesWithoutFile` that blocks `--copy` (Task 2) |
| #14 cropBox to mysql2 | `jsonOrNull()` (Task 2 Step 3); round-trip asserted in the first Task 2 test |
| #15 dry run proves nothing | vitest fixtures prove behaviour (Task 2), production gets a read-only `--plan` and a before/after smoke (Task 6 Steps 2, 7); no prod data in `declutter_test` |
| #16 4-byte JPEG stub | `writeTestJpeg()` with sharp (Task 3 Step 1) |
| #17 fixed names in shared `uploads/` | unique fixture names, guarded cleanup, `local/test-fake-` literals only where nothing deletes (Global Constraints, Task 3 Step 1) |
| #18/#19 Review Focus 2 and 5 untested | Task 3 tests "a source photo that is gone from disk…" and "lists filed photos … plus inbox photos …" |
| #24 numbering | Tasks 1–6, every cross-reference checked |
| #27/#28 rollout mechanics | `db/backup.mjs`, schema-A worktree, server stopped before the copy, build + restart before the drop (Task 6) |
| #29 approval before drop | Task 6 Step 8 |
| #30 migration number collisions | Global Constraints assumption; Task 1 Step 6 and Task 6 Step 0 re-check |
| #32 `scripts/batch-detect-local.mjs` | Task 4 Step 10 |
| R-P1, R-P2, R-P3 | Design decisions table; Task 4; Task 6 |

Out of scope by design: image-kind `captures` into `photos` (P2), drag-and-drop, foreign keys.

**2. Placeholder scan.** No TBD or TODO. Steps that edit long existing files (`inbox.ts`, `items.ts`, `ItemDetail.tsx`, `Annotate.tsx`) give exact replacement code or exact `sed` expressions, each followed by a `grep` whose expected output is stated. `pins.ts` is a copy of `annotations.ts` with listed `sed` renames and three hand edits shown in full; the parts left unchanged are the prompt texts and the AI-calling code, byte-identical by construction.

**3. Type consistency.** `coverPhotos(db, itemIds?)` returns `Map<number, { id; storageKey }>` and is used that way in `listPhotoCatalog`, `pins.ts`, `inbox.detectObjects` and `items.listByArea/listAll`. `photos.ensureForCapture` returns `{ photoId }` and every consumer reads `res.photoId`. `pins.listForItem` rows expose `photoId` and `photo`, read as `p.photoId` and `p.photo?.title` in ItemDetail and Annotate. `addPhoto`/`addItemLink`/`removePhoto`/`removeItemLink` have one signature each, shared by the routers and the aliases. `LegacyAttachment.id` is negative exactly for `item_links` rows, and `attachments.remove` decodes it with `input.id < 0`. `CopyPlan`/`CopyResult`/`VerifyResult` field names match between the library, the CLI and the tests.

**4. Review Focus coverage.** (1) identical notes and file-less images → Task 2 tests 2 and 3. (2) source file gone → Task 3 test "a source photo that is gone from disk…". (3) item deleted after cutover → Task 4 test "items.remove removes photos, pins on them, links and their files…". (4) alias id collision → Task 4 test "never confuse a photo and a link that share a numeric id". (5) catalog keeps un-filed inbox photos without duplicates → Task 3 test "lists filed photos with room, topic and cover flag, plus inbox photos that have no photo yet". Inputs already covered by task tests and so not listed in Review Focus: new filings visible everywhere (Task 4 first test), a file shared between a photo and a capture (Task 3), and two runs of the copy (Task 2).
