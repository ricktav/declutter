import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { areas, houses, items, storageDirs, storageVolumes } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(resetTestDb);

describe("storage tables", () => {
  it("exist with their key columns", async () => {
    const db = getTestDb();
    const [cols] = (await db.execute(
      sql`select table_name t, column_name c from information_schema.columns where table_schema = database() and table_name in ('storage_volumes','storage_dirs') order by 1, ordinal_position`,
    )) as unknown as [{ t: string; c: string }[]];
    const by = (t: string) => cols.filter((r) => r.t === t).map((r) => r.c);
    expect(by("storage_volumes")).toEqual(
      expect.arrayContaining(["id", "itemId", "mountPoint", "capacityBytes", "usedBytes", "dataRole", "measuredAt"]),
    );
    expect(by("storage_dirs")).toEqual(expect.arrayContaining(["id", "volumeId", "path", "bytes", "measuredAt"]));
  });
});

async function seedDevices() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: pc }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "mac-mini", attributes: { role: "desktop", storage_gb: 1000, storage_free_gb: 400 } })
    .$returningId();
  const [{ id: ssd }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "Internal SSD", parentId: pc, attributes: { role: "storage", drive_type: "nvme", storage_gb: 1000 } })
    .$returningId();
  const [{ id: nas }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "synology-nas", attributes: { role: "nas", storage_gb: 3933, storage_free_gb: 426 } })
    .$returningId();
  const [{ id: chair }] = await db.insert(items).values({ areaId, houseId, name: "Stoel", attributes: { role: "furniture" } }).$returningId();
  return { areaId, houseId, pc, ssd, nas, chair };
}

const GB = 1024 ** 3;

describe("storage.report", () => {
  it("creates volumes and directories for a drive and updates them on the next report", async () => {
    const { houseId, ssd } = await seedDevices();
    const c = callerFor(houseId);
    const first = await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [
        { mountPoint: "/", label: "Macintosh HD", fsType: "apfs", device: "disk3s1", capacityBytes: 994 * GB, usedBytes: 600 * GB, dirs: [{ path: "/Users", bytes: 500 * GB }, { path: "/Applications", bytes: 40 * GB }] },
        { mountPoint: "/Volumes/Data", capacityBytes: 994 * GB, usedBytes: 10 * GB },
      ],
    });
    expect(first).toEqual({ volumes: 2, dirs: 2 });
    const rows = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd));
    expect(rows.map((r) => [r.mountPoint, r.usedBytes, r.dataRole])).toEqual([
      ["/", 600 * GB, null],
      ["/Volumes/Data", 10 * GB, null],
    ]);

    await c.storage.setRole({ volumeId: rows[0].id, dataRole: "unique" });
    const second = await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [{ mountPoint: "/", capacityBytes: 994 * GB, usedBytes: 650 * GB, dirs: [{ path: "/Users", bytes: 550 * GB }] }],
    });
    expect(second).toEqual({ volumes: 1, dirs: 1 });
    const after = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd)).orderBy(storageVolumes.mountPoint);
    expect(after.map((r) => [r.mountPoint, r.usedBytes, r.dataRole])).toEqual([
      ["/", 650 * GB, "unique"], // role survives, use updated
      ["/Volumes/Data", 10 * GB, null], // missing from the later report: kept with its last measurement
    ]);
    expect(after[0].measuredAt.getTime()).toBeGreaterThanOrEqual(after[1].measuredAt.getTime());
    const dirs = await getTestDb().select().from(storageDirs).where(eq(storageDirs.volumeId, rows[0].id));
    expect(dirs.map((d) => [d.path, d.bytes])).toEqual([["/Users", 550 * GB]]); // replaced wholesale
  });

  it("keeps the same mount point on two devices as two volumes", async () => {
    const { houseId, pc, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: pc, source: "test", volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1 }] });
    await c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 2 * GB, usedBytes: 2 }] });
    const rows = await getTestDb().select().from(storageVolumes);
    expect(rows.map((r) => [r.itemId, r.capacityBytes]).sort((a, b) => a[0] - b[0])).toEqual([
      [pc, GB],
      [nas, 2 * GB],
    ]);
  });

  it("refuses a report for an item that is not a storage device or computer", async () => {
    const { houseId, chair } = await seedDevices();
    await expect(
      callerFor(houseId).storage.report({ itemId: chair, source: "test", volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await getTestDb().select().from(storageVolumes)).toHaveLength(0);
  });

  it("refuses used above capacity and keeps the device attributes in step", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await expect(
      c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/volume1", capacityBytes: GB, usedBytes: 2 * GB }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await c.storage.report({
      itemId: nas,
      source: "test",
      volumes: [
        { mountPoint: "/volume1", capacityBytes: 3000 * GB, usedBytes: 2000 * GB },
        { mountPoint: "/volume2", capacityBytes: 1000 * GB, usedBytes: 100 * GB },
      ],
    });
    const item = await getTestDb().query.items.findFirst({ where: eq(items.id, nas) });
    // the lab keys stay meaningful: whole-device GB, rounded, from the sum of the volumes
    expect(item?.attributes?.storage_gb).toBe(Math.round((4000 * GB) / 1e9));
    expect(item?.attributes?.storage_free_gb).toBe(Math.round((1900 * GB) / 1e9));
  });
});
