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
      expect.arrayContaining(["id", "itemId", "mountPoint", "container", "capacityBytes", "usedBytes", "dataRole", "measuredAt"]),
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

describe("storage.overview", () => {
  it("groups internal drives under their computer, externals apart, and falls back to attributes", async () => {
    const { houseId, pc, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 1000 * GB, usedBytes: 600 * GB }] });
    const o = await c.storage.overview({});
    expect(o.computers.map((x) => x.name)).toEqual(["mac-mini"]);
    const mini = o.computers[0];
    expect(mini.drives.map((d) => [d.name, d.measured, d.usedBytes])).toEqual([["Internal SSD", true, 600 * GB]]);
    expect(mini.drives[0].volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    // the computer itself has no volumes: block from its attributes, unmeasured
    expect([mini.measured, mini.capacityBytes, mini.usedBytes]).toEqual([false, 1000e9, 600e9]);
    const ext = o.externals.find((d) => d.id === nas)!;
    expect([ext.kind, ext.measured, ext.capacityBytes, ext.usedBytes]).toEqual(["nas", false, 3933e9, (3933 - 426) * 1e9]);
    expect(o.externals.map((d) => d.id)).not.toContain(pc);
    expect(o.externals.map((d) => d.id)).not.toContain(ssd);
  });

  it("totals sum every volume once and count the unassigned ones", async () => {
    const { houseId, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB }] });
    await c.storage.report({
      itemId: nas,
      source: "test",
      volumes: [
        { mountPoint: "/volume1", capacityBytes: 20 * GB, usedBytes: 15 * GB },
        { mountPoint: "/volume2", capacityBytes: 30 * GB, usedBytes: 1 * GB },
      ],
    });
    const vols = await getTestDb().select().from(storageVolumes);
    const v1 = vols.find((v) => v.mountPoint === "/volume1")!;
    await c.storage.setRole({ volumeId: v1.id, dataRole: "backup" });
    await c.storage.setRole({ volumeId: vols.find((v) => v.mountPoint === "/")!.id, dataRole: "backup" });
    const o = await c.storage.overview({});
    const backup = o.totals.find((t) => t.dataRole === "backup")!;
    expect([backup.volumes, backup.usedBytes]).toEqual([2, 19 * GB]);
    expect(o.totals.find((t) => t.dataRole === null)).toEqual({ dataRole: null, volumes: 1, usedBytes: 1 * GB });
    // without containers every volume is its own container: capacity is the plain sum
    expect([o.capacityBytes, o.freeBytes]).toEqual([60 * GB, 40 * GB]);
    expect(o.unassignedVolumes).toBe(1);
  });

  it("scopes to the context house but houseId null covers every house", async () => {
    const { pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "Zomerhuis" }).$returningId();
    const areaId = (await db.query.areas.findFirst())!.id;
    await db.insert(items).values({ areaId, houseId: h2, name: "pi-zomer", attributes: { role: "sbc" } });
    expect((await callerFor(h2).storage.overview({})).computers.map((c) => c.name)).toEqual(["pi-zomer"]);
    expect((await callerFor(h2).storage.overview({ houseId: null })).computers.map((c) => c.name).sort()).toEqual(["mac-mini", "pi-zomer"]);
    expect((await callerFor(null).storage.overview({})).computers.map((c) => c.id)).toContain(pc);
  });
});

describe("storage.dirs", () => {
  it("lists a volume's directories biggest first with its device", async () => {
    const { houseId, ssd } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: ssd,
      source: "test",
      volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB, dirs: [{ path: "/Applications", bytes: 1 * GB }, { path: "/Users", bytes: 3 * GB }] }],
    });
    const v = (await getTestDb().select().from(storageVolumes))[0];
    const d = await c.storage.dirs({ volumeId: v.id });
    expect(d.volume.itemName).toBe("Internal SSD");
    expect(Object.keys(d.volume).sort()).toEqual(
      ["capacityBytes", "dataRole", "device", "dirCount", "fsType", "id", "itemId", "itemName", "label", "measuredAt", "mountPoint", "usedBytes"],
    );
    expect(d.dirs.map((x) => [x.path, x.bytes])).toEqual([
      ["/Users", 3 * GB],
      ["/Applications", 1 * GB],
    ]);
    await expect(c.storage.dirs({ volumeId: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("archived devices", () => {
  it("drop out of the totals and refuse new reports", async () => {
    const { houseId, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB }] });
    await c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/volume1", capacityBytes: 20 * GB, usedBytes: 5 * GB }] });
    const before = await c.storage.overview({});
    expect(before.unassignedVolumes).toBe(2);
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, nas));
    const after = await c.storage.overview({});
    expect(after.unassignedVolumes).toBe(1);
    expect(after.totals).toEqual([{ dataRole: null, volumes: 1, usedBytes: 4 * GB }]);
    expect([after.capacityBytes, after.freeBytes]).toEqual([10 * GB, 6 * GB]);
    await expect(
      c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/volume1", capacityBytes: 20 * GB, usedBytes: 6 * GB }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const v = await getTestDb().query.storageVolumes.findFirst({ where: eq(storageVolumes.itemId, nas) });
    expect(v?.usedBytes).toBe(5 * GB); // nothing written
  });
});

describe("storage.removeVolume", () => {
  it("deletes one volume with its directories and recomputes the device keys", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: nas,
      source: "test",
      volumes: [
        { mountPoint: "/volume1", capacityBytes: 3000 * GB, usedBytes: 2000 * GB, dirs: [{ path: "/volume1/photo", bytes: 1500 * GB }] },
        { mountPoint: "/volume2", capacityBytes: 1000 * GB, usedBytes: 100 * GB, dirs: [{ path: "/volume2/tmp", bytes: 50 * GB }] },
      ],
    });
    const vols = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas));
    const v1 = vols.find((v) => v.mountPoint === "/volume1")!;
    const v2 = vols.find((v) => v.mountPoint === "/volume2")!;
    expect(await c.storage.removeVolume({ volumeId: v1.id })).toEqual({ removed: true });
    const left = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas));
    expect(left.map((v) => v.id)).toEqual([v2.id]);
    expect(await getTestDb().select().from(storageDirs).where(eq(storageDirs.volumeId, v1.id))).toHaveLength(0);
    expect(await getTestDb().select().from(storageDirs).where(eq(storageDirs.volumeId, v2.id))).toHaveLength(1);
    const item = await getTestDb().query.items.findFirst({ where: eq(items.id, nas) });
    expect(item?.attributes?.storage_gb).toBe(Math.round((1000 * GB) / 1e9));
    expect(item?.attributes?.storage_free_gb).toBe(Math.round((900 * GB) / 1e9));

    // the last volume goes: the keys stay as they were
    await c.storage.removeVolume({ volumeId: v2.id });
    const last = await getTestDb().query.items.findFirst({ where: eq(items.id, nas) });
    expect(last?.attributes?.storage_gb).toBe(Math.round((1000 * GB) / 1e9));
    await expect(c.storage.removeVolume({ volumeId: v1.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("containers", () => {
  const T7 = (used: number, container: string | null = "disk5") => ({ mountPoint: "/Volumes/T7", label: "T7", container, capacityBytes: 1000 * GB, usedBytes: used });
  const TM = (used: number, container: string | null = "disk5") => ({ mountPoint: "/Volumes/TM-T7", label: "TM-T7", container, capacityBytes: 1000 * GB, usedBytes: used });

  async function deviceKeys(id: number) {
    const item = await getTestDb().query.items.findFirst({ where: eq(items.id, id) });
    return [item?.attributes?.storage_gb, item?.attributes?.storage_free_gb];
  }

  it("counts a shared container's capacity once on the device, in the overview and in free", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB), TM(200 * GB)] });
    expect(await deviceKeys(nas)).toEqual([Math.round((1000 * GB) / 1e9), Math.round((500 * GB) / 1e9)]);
    const o = await c.storage.overview({});
    const d = o.externals.find((x) => x.id === nas)!;
    expect([d.capacityBytes, d.usedBytes, d.freeBytes]).toEqual([1000 * GB, 500 * GB, 500 * GB]);
    expect(d.volumes.map((v) => [v.label, v.container, v.shareOfContainer])).toEqual([
      ["T7", "disk5", 0.3],
      ["TM-T7", "disk5", 0.2],
    ]);
    expect([o.capacityBytes, o.freeBytes]).toEqual([1000 * GB, 500 * GB]);
  });

  it("counts the container once when its volumes come in two separate reports", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB)] });
    await c.storage.report({ itemId: nas, source: "test", volumes: [TM(200 * GB)] });
    expect(await deviceKeys(nas)).toEqual([Math.round((1000 * GB) / 1e9), Math.round((500 * GB) / 1e9)]);
    const o = await c.storage.overview({});
    const d = o.externals.find((x) => x.id === nas)!;
    expect([d.capacityBytes, d.usedBytes, d.freeBytes]).toEqual([1000 * GB, 500 * GB, 500 * GB]);
    expect([o.capacityBytes, o.freeBytes]).toEqual([1000 * GB, 500 * GB]);
    // the second report must still fit the container with the first one's volume
    await expect(c.storage.report({ itemId: nas, source: "test", volumes: [TM(800 * GB)] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const tm = await getTestDb().query.storageVolumes.findFirst({ where: eq(storageVolumes.mountPoint, "/Volumes/TM-T7") });
    expect(tm?.usedBytes).toBe(200 * GB); // nothing written
  });

  it("updates a volume that moves container in place", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB, "disk5")] });
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(310 * GB, "disk7")] });
    const rows = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas));
    expect(rows.map((r) => [r.mountPoint, r.container, r.usedBytes])).toEqual([["/Volumes/T7", "disk7", 310 * GB]]);
    // an old payload without the field makes it its own container again
    await c.storage.report({ itemId: nas, source: "test", volumes: [{ mountPoint: "/Volumes/T7", capacityBytes: 1000 * GB, usedBytes: 310 * GB }] });
    const again = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas));
    expect(again.map((r) => [r.mountPoint, r.container])).toEqual([["/Volumes/T7", null]]);
  });

  it("keeps the container's capacity when one of its volumes is removed", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB), TM(200 * GB)] });
    const tm = (await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas))).find((v) => v.label === "TM-T7")!;
    await c.storage.removeVolume({ volumeId: tm.id });
    expect(await deviceKeys(nas)).toEqual([Math.round((1000 * GB) / 1e9), Math.round((700 * GB) / 1e9)]);
    const d = (await c.storage.overview({})).externals.find((x) => x.id === nas)!;
    expect([d.capacityBytes, d.usedBytes, d.freeBytes]).toEqual([1000 * GB, 300 * GB, 700 * GB]);
  });

  it("totals count used bytes per role exactly while free stays with no role", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB), TM(200 * GB)] });
    const before = await c.storage.overview({});
    const vols = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, nas));
    await c.storage.setRole({ volumeId: vols.find((v) => v.label === "TM-T7")!.id, dataRole: "backup" });
    await c.storage.setRole({ volumeId: vols.find((v) => v.label === "T7")!.id, dataRole: "archive" });
    const o = await c.storage.overview({});
    const by = (r: string) => o.totals.find((t) => t.dataRole === r);
    expect(by("backup")).toEqual({ dataRole: "backup", volumes: 1, usedBytes: 200 * GB });
    expect(by("archive")).toEqual({ dataRole: "archive", volumes: 1, usedBytes: 300 * GB });
    expect(o.totals.find((t) => t.dataRole === null)).toBeUndefined();
    expect(o.unassignedVolumes).toBe(0);
    expect([o.capacityBytes, o.freeBytes]).toEqual([before.capacityBytes, before.freeBytes]);
    expect(o.freeBytes).toBe(500 * GB);
  });

  it("refuses a report whose volumes disagree on their container's capacity", async () => {
    const { houseId, nas } = await seedDevices();
    await expect(
      callerFor(houseId).storage.report({ itemId: nas, source: "test", volumes: [T7(300 * GB), { ...TM(200 * GB), capacityBytes: 900 * GB }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "container disk5: capacity differs between volumes." });
    expect(await getTestDb().select().from(storageVolumes)).toHaveLength(0);
  });
});

describe("attached-to and backs-up in the overview", () => {
  it("hangs an attached drive under its computer and takes it out of externals", async () => {
    const { houseId, pc, nas } = await seedDevices();
    const c = callerFor(houseId);
    const { id: relId } = await c.items.addRelation({ fromItemId: nas, toItemId: pc, type: "attached-to" });
    const o = await c.storage.overview({});
    const mac = o.computers.find((x) => x.id === pc)!;
    expect(mac.attached.map((d) => [d.id, d.attachedRelationId])).toEqual([[nas, relId]]);
    expect(mac.drives.map((d) => d.attachedRelationId)).toEqual([null]);
    expect(o.externals.map((d) => d.id)).not.toContain(nas);
  });

  it("keeps the drive external when its computer is archived", async () => {
    const { houseId, pc, nas } = await seedDevices();
    const c = callerFor(houseId);
    const { id: relId } = await c.items.addRelation({ fromItemId: nas, toItemId: pc, type: "attached-to" });
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, pc));
    const o = await c.storage.overview({});
    expect(o.computers.map((x) => x.id)).not.toContain(pc);
    expect(o.computers.every((x) => x.attached.length === 0)).toBe(true);
    const d = o.externals.find((x) => x.id === nas);
    expect(d?.attachedRelationId).toBe(relId);
  });

  it("lists the items a NAS backs up by name", async () => {
    const { areaId, houseId, pc, nas } = await seedDevices();
    const db = getTestDb();
    const [{ id: phone }] = await db.insert(items).values({ areaId, houseId, name: "iPhone" }).$returningId();
    const c = callerFor(houseId);
    const r1 = await c.items.addRelation({ fromItemId: nas, toItemId: pc, type: "backs-up" });
    const r2 = await c.items.addRelation({ fromItemId: nas, toItemId: phone, type: "backs-up" });
    const o = await c.storage.overview({});
    const d = o.externals.find((x) => x.id === nas)!;
    expect(d.backsUp).toEqual([
      { relationId: r1.id, itemId: pc, name: "mac-mini" },
      { relationId: r2.id, itemId: phone, name: "iPhone" },
    ]);
    expect(o.computers.find((x) => x.id === pc)!.backsUp).toEqual([]);
  });
});
