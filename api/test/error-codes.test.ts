import { beforeEach, describe, expect, it } from "vitest";
import { areas } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

describe("router errors carry a tRPC code, not INTERNAL_SERVER_ERROR", () => {
  it("NOT_FOUND for a missing Thing", async () => {
    await expect(callerFor(null).items.setDecision({ id: 999999, decision: "keep" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(null).items.patchAttributes({ id: 999999, set: { brand: "x" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUND for a missing capture", async () => {
    await expect(callerFor(null).inbox.triage({ id: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("BAD_REQUEST for moving a house into itself", async () => {
    await expect(callerFor(null).houses.reassign({ fromId: 1, toId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("CONFLICT for a slug that another topic uses", async () => {
    const db = getTestDb();
    await db.insert(areas).values({ slug: "taken", name: "Taken" });
    const [{ id }] = await db.insert(areas).values({ slug: "free", name: "Free" }).$returningId();
    await expect(callerFor(null).areas.update({ id, slug: "taken" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
