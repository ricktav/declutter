// Background triage: inbox.create of a photo queues a triage when the
// setting is on, the Sort card then arrives with a suggestion; a failure is
// retried once and then stays visible on the row and in the history.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { areas, captures, events, houses } from "@db/schema";
import { enqueueTriage, resetTriageJobs, triageJobsIdle } from "../lib/jobs";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

const model = vi.hoisted(() => ({ answer: null as unknown, calls: 0, gate: null as Promise<void> | null }));

vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai")>()),
  getModel: async () => ({}),
  getTriageModel: async () => ({}),
  getTriageVisionModel: async () => ({}),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => {
    model.calls++;
    if (model.gate) await model.gate;
    if (model.answer instanceof Error) throw model.answer;
    return { object: schema.parse(model.answer) };
  },
}));

let dir: string;
let before: string | undefined;
let h1: number;

beforeEach(async () => {
  await resetTestDb();
  resetTriageJobs();
  model.answer = { note: "shelf", floor: null, room: null, items: [] };
  model.calls = 0;
  model.gate = null;
  before = process.env.DECLUTTER_SETTINGS_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-autotriage-"));
  process.env.DECLUTTER_SETTINGS_PATH = path.join(dir, "settings.json");
  const db = getTestDb();
  [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  await db.insert(areas).values({ slug: "x", name: "X" });
});
afterEach(async () => {
  await triageJobsIdle();
  process.env.DECLUTTER_SETTINGS_PATH = before;
  fs.rmSync(dir, { recursive: true, force: true });
  await removeTestUploads();
});

async function snap(kind: "image" | "note" = "image") {
  const storageKey = kind === "image" ? await writeTestJpeg() : undefined;
  const { id } = await callerFor(h1).inbox.create({ kind, storageKey, rawText: kind === "note" ? "a pan" : undefined });
  return id;
}
const row = async (id: number) => (await callerFor(h1).inbox.list()).find((c) => c.id === id)!;

describe("background triage", () => {
  it("is off by default: a new photo waits for the button", async () => {
    const id = await snap();
    await triageJobsIdle();
    expect(model.calls).toBe(0);
    expect(await row(id)).toMatchObject({ triageState: null, triageError: null, suggestion: null });
  });

  it("triages a new photo when switched on, so the row arrives done", async () => {
    expect(await callerFor(null).settings.setAutoTriage({ on: true })).toEqual({ autoTriage: true, ready: true });
    expect((await callerFor(null).settings.get()).settings.autoTriage).toBe(true);
    const id = await snap();
    expect((await row(id)).triageState).toMatch(/queued|running/);
    await triageJobsIdle();
    const r = await row(id);
    expect(r.triageState).toBe("done");
    expect(r.suggestion).toMatchObject({ note: "shelf" });
  });

  it("leaves notes to the button", async () => {
    await callerFor(null).settings.setAutoTriage({ on: true });
    const id = await snap("note");
    await triageJobsIdle();
    expect(model.calls).toBe(0);
    expect((await row(id)).triageState).toBeNull();
  });

  it("retries once, then shows the failure on the row and in the history", async () => {
    await callerFor(null).settings.setAutoTriage({ on: true });
    model.answer = new Error("provider down");
    const id = await snap();
    await triageJobsIdle();
    expect(model.calls).toBe(2);
    const r = await row(id);
    expect(r.triageState).toBe("failed");
    expect(r.triageError).toBeTruthy();
    const logged = await getTestDb()
      .select()
      .from(events)
      .where(and(eq(events.entityType, "capture"), eq(events.entityId, id), eq(events.action, "triage-failed")));
    expect(logged).toHaveLength(1);

    model.answer = { note: "second try", floor: null, room: null, items: [] };
    expect((await callerFor(h1).inbox.triage({ id })).ok).toBe(true);
    expect((await row(id)).triageState).toBe("done");
  });

  it("skips a snap that was sorted before its turn came", async () => {
    await callerFor(null).settings.setAutoTriage({ on: true });
    let release = () => {};
    model.gate = new Promise<void>((r) => (release = r));
    const first = await snap();
    const [{ id: second }] = await getTestDb().insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();
    enqueueTriage(second, h1);
    await getTestDb().update(captures).set({ status: "dismissed" }).where(eq(captures.id, second));
    release();
    await triageJobsIdle();
    expect(model.calls).toBe(1);
    expect((await row(first)).triageState).toBe("done");
    expect((await row(second)).triageState).toBeNull();
  });
});
