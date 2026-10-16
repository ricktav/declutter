// AI prompts list candidate Things from the capture's or Photo's house only,
// its room first, and never archived or rejected ones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, items, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";
import { captureScope, photoScope, promptInventory } from "../lib/aiContext";

const seen = vi.hoisted(() => ({ prompts: [] as string[] }));

vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai")>()),
  getModel: async () => ({}),
  getTriageModel: async () => ({}),
  getTriageVisionModel: async () => ({}),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: async ({ messages }: { messages: { content: { type: string; text?: string }[] }[] }) => {
    seen.prompts.push(messages.flatMap((m) => m.content.filter((p) => p.type === "text").map((p) => p.text)).join("\n"));
    return { object: { note: "", floor: null, room: null, items: [] } };
  },
}));

beforeEach(async () => {
  await resetTestDb();
  seen.prompts = [];
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: hA }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: hB }] = await db.insert(houses).values({ name: "B" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: kitchen }] = await db.insert(rooms).values({ houseId: hA, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: shed }] = await db.insert(rooms).values({ houseId: hB, name: "Schuur", floor: "ground", source: "manual" }).$returningId();
  const t0 = new Date("2026-10-01T10:00:00Z");
  const t1 = new Date("2026-10-02T10:00:00Z");
  await db.insert(items).values([
    { areaId, houseId: hA, name: "lamp in A, unplaced", updatedAt: t1 },
    { areaId, houseId: hA, roomId: kitchen, name: "kettle in A kitchen", updatedAt: t0 },
    { areaId, houseId: hA, name: "archived in A", status: "archived" },
    { areaId, houseId: hA, name: "rejected in A", verificationStatus: "rejected" },
    { areaId, houseId: hB, roomId: shed, name: "drill in B" },
  ]);
  return { db, hA, hB, kitchen, shed };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("promptInventory", () => {
  it("keeps one house's active, not rejected Things, newest first", async () => {
    const { db, hA } = await seed();
    expect(names(await promptInventory(db, { houseId: hA, roomId: null }))).toEqual(["lamp in A, unplaced", "kettle in A kitchen"]);
  });

  it("lists the scope's room first", async () => {
    const { db, hA, kitchen } = await seed();
    expect(names(await promptInventory(db, { houseId: hA, roomId: kitchen }))).toEqual(["kettle in A kitchen", "lamp in A, unplaced"]);
  });

  it("covers every house without one, and honours the limit", async () => {
    const { db } = await seed();
    expect(await promptInventory(db, { houseId: null, roomId: null })).toHaveLength(3);
    expect(await promptInventory(db, { houseId: null, roomId: null }, 1)).toHaveLength(1);
  });
});

describe("scope of a capture and a Photo", () => {
  it("a capture's location Photo room wins over its stamp and the session", async () => {
    const { db, hA, hB, shed } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", houseId: hA }).$returningId();
    const [cap] = await db.select().from(captures).where(eq(captures.id, capId));
    expect(await captureScope(db, cap, null)).toEqual({ houseId: hA, roomId: null });
    expect(await captureScope(db, { ...cap, houseId: null }, hB)).toEqual({ houseId: hB, roomId: null });
    await db.insert(photos).values({ sourceCaptureId: capId, roomId: shed, storageKey: "local/test-fake-loc.jpg" });
    expect(await captureScope(db, cap, hA)).toEqual({ houseId: hB, roomId: shed });
  });

  it("a Photo without a room takes its Thing's house", async () => {
    const { db, hB } = await seed();
    const [drill] = await db.select().from(items).where(eq(items.name, "drill in B"));
    const [{ id }] = await db.insert(photos).values({ itemId: drill.id, areaId: drill.areaId, storageKey: "local/test-fake-p.jpg" }).$returningId();
    const [photo] = await db.select().from(photos).where(eq(photos.id, id));
    expect(await photoScope(db, photo, null)).toEqual({ houseId: hB, roomId: null });
  });
});

describe("inbox.triage prompt", () => {
  it("names only the capture's house's Things", async () => {
    const { db, hA } = await seed();
    const storageKey = await writeTestJpeg();
    const [{ id }] = await db.insert(captures).values({ kind: "image", storageKey, houseId: hA }).$returningId();
    const res = await callerFor(null).inbox.triage({ id });
    expect(res.ok).toBe(true);
    const prompt = seen.prompts.join("\n");
    expect(prompt).toContain("lamp in A, unplaced");
    expect(prompt).not.toContain("drill in B");
    expect(prompt).not.toContain("rejected in A");
  });
});
