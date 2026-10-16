import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { areas, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

let dir: string;
let before: string | undefined;

beforeEach(async () => {
  await resetTestDb();
  before = process.env.DECLUTTER_SETTINGS_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-settings-"));
  process.env.DECLUTTER_SETTINGS_PATH = path.join(dir, "settings.json");
});
afterEach(() => {
  process.env.DECLUTTER_SETTINGS_PATH = before;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("settings.ui depth", () => {
  it("starts at quick for an empty inventory", async () => {
    expect(await callerFor(null).settings.ui()).toEqual({ depth: "quick", chosen: false });
  });

  it("starts at detail once Things exist, so an existing install hides nothing", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    await db.insert(items).values({ areaId, name: "lamp" });
    expect(await callerFor(null).settings.ui()).toEqual({ depth: "detail", chosen: false });
  });

  it("keeps a chosen depth, whatever the inventory", async () => {
    await callerFor(null).settings.setDepth({ depth: "standard" });
    expect(await callerFor(null).settings.ui()).toEqual({ depth: "standard", chosen: true });
  });

  it("refuses an unknown depth", async () => {
    // @ts-expect-error not a depth
    await expect(callerFor(null).settings.setDepth({ depth: "expert" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
