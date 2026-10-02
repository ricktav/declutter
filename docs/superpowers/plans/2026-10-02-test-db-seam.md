# Test Database Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the backend a disposable test database so Drizzle/tRPC logic can be built with real TDD, without ever touching `DATABASE_URL`.

**Architecture:** A second MySQL database reached via `TEST_DATABASE_URL`, migrated once per test run by a vitest `globalSetup` hook (reusing the project's own `db/migrations`), plus a small `api/test/db.ts` module exposing `getTestDb()` and a `resetTestDb()` that truncates every table declared in `db/schema.ts` — table list derived from the schema module itself, not hand-maintained, so a table added later is covered automatically.

**Tech Stack:** drizzle-orm (`drizzle-orm/mysql2`, `drizzle-orm/mysql2/migrator`) and drizzle-kit — both already in `package.json`, no new dependencies. vitest (already configured, currently 0 test files).

**Spec:** This plan is prerequisite infrastructure for the HomeBase Phase 3 migration (see the architecture review roadmap, section 10, and `/Users/ricktav/.claude/projects/-Volumes-T7-declutter/memory/homebase-review-decisions.md`). No DB-touching Phase 3 plan (rooms consolidation, photos consolidation, router/FK cleanup) can follow TDD until this seam exists — confirmed by code research: `api/queries/connection.ts` is a hardcoded singleton with no injection point, and zero `*.test.ts`/`*.spec.ts` files exist in the repo today despite `vitest.config.ts` already declaring test globs for them.

## Global Constraints

- No new npm dependencies — `drizzle-orm/mysql2/migrator` and `drizzle-kit` are already installed.
- `TEST_DATABASE_URL` must never equal `DATABASE_URL` — `resetTestDb()` truncates every table, so this is a hard safety guard, not a suggestion.
- MySQL only, same dialect as production (`mode: "default"`, matching `api/queries/connection.ts:9`) — no sqlite/in-memory substitute, so the test DB stays schema-compatible with real migrations.
- Must not modify `api/queries/connection.ts` or any existing router — this plan only adds new files plus two small config edits (`vitest.config.ts`, `.env.example`).
- Reuse the committed `db/migrations/` folder as the single source of schema truth for the test DB (same `drizzle-kit generate`/`migrate` convention the project already moved to — do not hand-write SQL or call `drizzle-kit push`).

## Review Focus

- **`TEST_DATABASE_URL` unset when tests run.** A reasonable person expects a clear error naming the missing variable, not a raw `mysql2` ECONNREFUSED/host-lookup failure three layers down. Covered in Task 1.
- **`TEST_DATABASE_URL` accidentally set equal to `DATABASE_URL`.** The most expensive possible mistake here — `resetTestDb()` would truncate the real production register (105 items, 83 attachments, 504 events per the live-DB counts in the architecture review). Must refuse to run, loudly. Covered in Task 1.
- **A table added to `db/schema.ts` after this plan ships.** If the truncate list were a hand-written array of table names, a new table would silently escape resets and leak rows between test files. The table list must be derived from the schema module at call time (`Object.values(schema)` filtered to actual tables), not hardcoded. Covered in Task 3.
- **Running the test suite twice in a row, including after a crashed previous run.** `globalSetup` must leave the test DB in a migrated, known state every time it runs — not assume a clean slate it inherited from a prior pass. Covered in Task 2 (migrate runs unconditionally on every invocation; it's idempotent because `drizzle-orm`'s migrator tracks applied migrations in its own table).
- **Test DB schema silently drifting from the committed migrations** (someone edited the test DB by hand, or an old migration run was interrupted). Re-running `migrate()` unconditionally at the start of every `vitest run` (not once per machine, not cached) means drift surfaces immediately as a migrator error instead of as a mysterious later test failure. Covered in Task 2.

---

## File Structure

- Create: `api/test/db.ts` — `requireTestDatabaseUrl()`, `getTestDb()`, `resetTestDb()`.
- Create: `api/test/db.test.ts` — unit tests for `requireTestDatabaseUrl()` (pure, no DB connection).
- Create: `api/test/globalSetup.ts` — vitest `globalSetup` export; runs the migrator once before the whole suite.
- Create: `api/test/db.smoke.test.ts` — the first real integration test, proving `getTestDb()`/`resetTestDb()` round-trip against a live test database. Also serves as the copy-paste example later Phase 3 plans (rooms, photos, SSOT fields) build their own DB tests from.
- Modify: `vitest.config.ts` — add the `@db` alias (missing today — `api/queries/connection.ts` and every router import schema via `@db/schema`, but vitest's `resolve.alias` only defines `@`, `@contracts`, `@assets`, so any test importing the schema fails to resolve before this fix) and register `globalSetup`.
- Modify: `.env.example` — document `TEST_DATABASE_URL` next to `DATABASE_URL`.

---

### Task 1: `requireTestDatabaseUrl()` — the safety guard

**Files:**
- Create: `api/test/db.ts`
- Test: `api/test/db.test.ts`

**Interfaces:**
- Produces: `requireTestDatabaseUrl(vars?: Pick<NodeJS.ProcessEnv, "TEST_DATABASE_URL" | "DATABASE_URL">): string` — later tasks in this plan call it with no argument (defaults to `process.env`); later Phase 3 plans import it from `api/test/db.ts` the same way.

- [ ] **Step 1: Write the failing tests**

```typescript
// api/test/db.test.ts
import { describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "./db";

describe("requireTestDatabaseUrl", () => {
  it("throws when TEST_DATABASE_URL is unset", () => {
    expect(() => requireTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("throws when TEST_DATABASE_URL equals DATABASE_URL", () => {
    expect(() =>
      requireTestDatabaseUrl({
        TEST_DATABASE_URL: "mysql://same/db",
        DATABASE_URL: "mysql://same/db",
      }),
    ).toThrow(/must not equal DATABASE_URL/);
  });

  it("returns the value when set and different from DATABASE_URL", () => {
    expect(
      requireTestDatabaseUrl({
        TEST_DATABASE_URL: "mysql://test-host/homebase_test",
        DATABASE_URL: "mysql://prod-host/homebase",
      }),
    ).toBe("mysql://test-host/homebase_test");
  });

  it("returns the value when DATABASE_URL is unset entirely", () => {
    expect(
      requireTestDatabaseUrl({ TEST_DATABASE_URL: "mysql://test-host/homebase_test" }),
    ).toBe("mysql://test-host/homebase_test");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/test/db.test.ts`
Expected: FAIL — `api/test/db.ts` does not exist yet (`Cannot find module './db'`).

- [ ] **Step 3: Write the minimal implementation**

```typescript
// api/test/db.ts
export function requireTestDatabaseUrl(
  vars: Pick<NodeJS.ProcessEnv, "TEST_DATABASE_URL" | "DATABASE_URL"> = process.env,
): string {
  const testUrl = vars.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a disposable MySQL database, e.g. " +
        "mysql://user:password@localhost:3306/homebase_test",
    );
  }
  if (testUrl === vars.DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL must not equal DATABASE_URL — resetTestDb() truncates every " +
        "table and would destroy production data.",
    );
  }
  return testUrl;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/test/db.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add api/test/db.ts api/test/db.test.ts
git commit -m "test: add requireTestDatabaseUrl safety guard"
```

---

### Task 2: vitest wiring — `@db` alias and migration `globalSetup`

**Files:**
- Create: `api/test/globalSetup.ts`
- Modify: `vitest.config.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `requireTestDatabaseUrl()` from Task 1 (`api/test/db.ts`).
- Produces: nothing importable — this task's deliverable is "the suite's test database is migrated before any test file runs," verified manually below rather than by a vitest test (vitest cannot test its own `globalSetup` wiring from inside a test file in the same run).

- [ ] **Step 1: Add the `@db` alias and `globalSetup` to vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@db": path.resolve(templateRoot, "db"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["api/**/*.test.ts", "api/**/*.spec.ts"],
    globalSetup: ["./api/test/globalSetup.ts"],
  },
});
```

- [ ] **Step 2: Write `api/test/globalSetup.ts`**

```typescript
// api/test/globalSetup.ts
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { requireTestDatabaseUrl } from "./db";

export default async function globalSetup() {
  const db = drizzle(requireTestDatabaseUrl(), { mode: "default" });
  await migrate(db, { migrationsFolder: "./db/migrations" });
}
```

- [ ] **Step 3: Document `TEST_DATABASE_URL` in `.env.example`**

```
# DATABASE_URL=mysql://user:password@host:3306/dbname
# TEST_DATABASE_URL — a second, disposable database for `npm test`.
# resetTestDb() truncates every table in it on every test run; never point
# this at the same database as DATABASE_URL.
#   TEST_DATABASE_URL=mysql://user:password@host:3306/dbname_test
```

Add this block immediately after the existing `DATABASE_URL` line in `.env.example`.

- [ ] **Step 4: Create the local test database and verify migration runs clean**

```bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS homebase_test"
```

Add `TEST_DATABASE_URL=mysql://root@localhost:3306/homebase_test` (adjust credentials to match your local MySQL) to `.env`.

Run: `npx vitest run api/test/db.test.ts`
Expected: the 4 tests from Task 1 still PASS, and no error is thrown during `globalSetup` (migration applies cleanly — you can confirm with `mysql -u root homebase_test -e "SHOW TABLES"` and see every table from `db/schema.ts`, plus drizzle's own migrations-tracking table).

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts .env.example api/test/globalSetup.ts
git commit -m "test: migrate a dedicated test database before the suite runs"
```

---

### Task 3: `getTestDb()` / `resetTestDb()` — proven by a smoke test

**Files:**
- Modify: `api/test/db.ts`
- Create: `api/test/db.smoke.test.ts`

**Interfaces:**
- Consumes: `requireTestDatabaseUrl()` (Task 1); the migrated test DB from Task 2's `globalSetup`.
- Produces: `getTestDb(): ReturnType<typeof drizzle<typeof schema>>`, `resetTestDb(): Promise<void>` — every later Phase 3 plan's DB-touching tests import these two from `api/test/db.ts` and call `resetTestDb()` in a `beforeEach`.

- [ ] **Step 1: Write the failing smoke test**

```typescript
// api/test/db.smoke.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { areas } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";

beforeEach(async () => {
  await resetTestDb();
});

describe("test database seam", () => {
  it("round-trips a row, and resetTestDb() clears it for the next test", async () => {
    const db = getTestDb();
    await db.insert(areas).values({ slug: "smoke-test", name: "Smoke Test" });

    const rows = await db.select().from(areas);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("smoke-test");

    await resetTestDb();
    const after = await db.select().from(areas);
    expect(after).toHaveLength(0);
  });

  it("starts clean even though the previous test inserted a row", async () => {
    const db = getTestDb();
    const rows = await db.select().from(areas);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run api/test/db.smoke.test.ts`
Expected: FAIL — `getTestDb`/`resetTestDb` are not exported from `./db` yet.

- [ ] **Step 3: Implement `getTestDb()` and `resetTestDb()`**

```typescript
// api/test/db.ts — append to the file from Task 1
import { drizzle } from "drizzle-orm/mysql2";
import { is, sql } from "drizzle-orm";
import { MySqlTable, getTableName } from "drizzle-orm/mysql-core";
import * as schema from "@db/schema";

let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getTestDb() {
  if (!instance) {
    instance = drizzle(requireTestDatabaseUrl(), { mode: "default", schema });
  }
  return instance;
}

export async function resetTestDb(): Promise<void> {
  const db = getTestDb();
  const tables = Object.values(schema).filter(
    (value): value is MySqlTable => is(value, MySqlTable),
  );

  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of tables) {
    await db.execute(sql.raw(`TRUNCATE TABLE \`${getTableName(table)}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run api/test/db.smoke.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all tests across Tasks 1–3 (6 tests total), `globalSetup` runs once before them.

- [ ] **Step 6: Commit**

```bash
git add api/test/db.ts api/test/db.smoke.test.ts
git commit -m "test: add getTestDb/resetTestDb, derived from the live schema"
```

---

## Self-Review

**1. Spec coverage.** The spec (this plan's own goal) is: a test DB reachable by env var, migrated automatically, with a reset helper that can't touch production and can't go stale as the schema grows. Task 1 covers the production-safety guard, Task 2 covers migration automation, Task 3 covers the reset helper and proves the whole chain end-to-end. No gaps.

**2. Placeholder scan.** No TBD/TODO, no "add appropriate error handling" — every error message is written out verbatim, every step shows real code or a real runnable command with an expected result.

**3. Type consistency.** `requireTestDatabaseUrl` is defined once in Task 1 and consumed with the identical name/signature in Task 2 (`globalSetup.ts`) and implicitly in Task 3 (`getTestDb` calls it internally). `getTestDb()`/`resetTestDb()` are defined in Task 3 and are the two names every later Phase 3 plan is told to import.

**4. Review Focus coverage.** All five items from the Review Focus section map to a task: unset var and prod/test collision → Task 1's tests; drift/double-run safety → Task 2's unconditional migrate; new-table leakage → Task 3's schema-derived table list (not a hardcoded array).

---

Plan complete and saved to `docs/superpowers/plans/2026-10-02-test-db-seam.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer checks the whole branch at the end. Cheapest and fastest; no independent review until the end.

For this plan I'd lean **Native**: it's 3 small, independently-committable tasks with no tricky cross-task interface risk (Task 2 and 3 each consume exactly one function from Task 1), so a fresh subagent per task is more overhead than the risk warrants. Does this plan capture what you want, and which approach should we use?

---

## Executed 2026-10-02 (branch `feat/test-db-seam`) — deviations from the draft above

- **Guard parses URLs.** `requireTestDatabaseUrl()` compares host, port and database name
  (so `host/db` and `host:3306/db` are recognised as the same database) and additionally
  requires the test database name to end in `_test`. The same-database check wins when both
  apply.
- **`.env` is loaded.** `api/test/db.ts` and `globalSetup.ts` import `dotenv/config`; nothing
  else in the test path did, so the guard would otherwise always throw "not set".
- **Routers are covered.** `api/queries/connection.ts` gained `setDbForTests()`; the vitest
  `setupFiles` entry `api/test/setup.ts` points the app's `getDb()` at the test database in
  every worker before a test file's imports run. The smoke test asserts `getDb()` resolves to a
  `_test` database. The draft's "must not modify connection.ts" constraint was dropped for this.
- **Serial files.** `fileParallelism: false`, because all files share one test database.
- **Pools close.** `globalSetup` ends its pool; `closeTestDb()` runs in `afterAll` from the setup
  file.
- **Database provisioning** was done by hand on the MySQL host (`declutter_test`, same user),
  since the app user cannot `CREATE DATABASE`; the draft's local `mysql -u root` step does not
  apply.
- Tests: 6 guard tests, 4 smoke tests (round-trip, clean start, `getDb()` routing, schema-wide
  truncate).
