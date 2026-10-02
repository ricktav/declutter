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

    // drizzle wraps the driver error; the MySQL message is on .cause
    await expect(
      db.insert(rooms).values({ houseId, name: "keuken", source: "manual" }),
    ).rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY", message: /Duplicate entry/ } });
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
