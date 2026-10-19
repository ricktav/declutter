import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { areas, houses, items, relations, storageDirs, storageVolumes } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { clusterByTwinKeys, machineTwinKeys, physicalDiskKey, sameVolume, volumeDedupeIsSafe } from "../lib/storageDisks";
import { isCoreSimulatorMount } from "../lib/storage";

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

const SIM_IOS = "/Library/Developer/CoreSimulator/Volumes/iOS_21F79";
const SIM_WATCH = "/Library/Developer/CoreSimulator/Volumes/watchOS_21T575";

describe("CoreSimulator volumes", () => {
  it("matches the CoreSimulator prefix and not a normal mount", () => {
    expect(isCoreSimulatorMount(SIM_IOS)).toBe(true);
    expect(isCoreSimulatorMount(SIM_WATCH)).toBe(true);
    expect(isCoreSimulatorMount("/Library/Developer/CoreSimulator/")).toBe(true);
    expect(isCoreSimulatorMount("/")).toBe(false);
    expect(isCoreSimulatorMount("/Library/Developer")).toBe(false);
    expect(isCoreSimulatorMount("/Volumes/iOS_21F79")).toBe(false);
  });

  it("does not create a volume from a tracker CoreSimulator row or a storage.report of that mount; / still does", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
    const [{ id: air }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "macbook-air-m2", attributes: { role: "laptop", hostname: "macbook-air-m2" } })
      .$returningId();
    const c = callerFor(houseId);

    const imported = await c.storage.importSources({
      sources: {
        sources: [
          {
            type: "file",
            name: "macbook-air-m2:/Library/Developer/CoreSimulator/Volumes/iOS_21F79",
            size_bytes: 20e9,
            used_bytes: 10e9,
          },
          {
            type: "file",
            name: "macbook-air-m2:/",
            size_bytes: 250e9,
            used_bytes: 100e9,
          },
        ],
      },
      dry: false,
    });
    expect(imported.skippedSimulator).toBe(1);
    const afterImport = await db.select().from(storageVolumes).where(eq(storageVolumes.itemId, air));
    expect(afterImport.map((r) => r.mountPoint)).toEqual(["/"]);
    expect(afterImport.find((r) => r.mountPoint === "/")?.usedBytes).toBe(100e9);

    const reported = await c.storage.report({
      itemId: air,
      source: "test",
      volumes: [
        { mountPoint: SIM_IOS, capacityBytes: 20e9, usedBytes: 12e9 },
        { mountPoint: SIM_WATCH, capacityBytes: 8e9, usedBytes: 3e9 },
        { mountPoint: "/", capacityBytes: 250e9, usedBytes: 110e9 },
      ],
    });
    expect(reported.volumes).toBe(1);
    const afterReport = await db.select().from(storageVolumes).where(eq(storageVolumes.itemId, air));
    expect(afterReport.map((r) => r.mountPoint)).toEqual(["/"]);
    expect(afterReport.find((r) => r.mountPoint === "/")?.usedBytes).toBe(110e9);
  });

  it("does not refresh an existing CoreSimulator volume and does not delete it", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
    const [{ id: air }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "macbook-air-m2", attributes: { role: "laptop", hostname: "macbook-air-m2" } })
      .$returningId();
    await db.insert(storageVolumes).values({
      itemId: air,
      mountPoint: SIM_IOS,
      capacityBytes: 20e9,
      usedBytes: 5e9,
      source: "legacy",
      measuredAt: new Date("2026-01-01T12:00:00Z"),
    });
    const before = await db.query.storageVolumes.findFirst({ where: eq(storageVolumes.mountPoint, SIM_IOS) });
    expect(before).toBeTruthy();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: air,
      source: "test",
      volumes: [
        { mountPoint: SIM_IOS, capacityBytes: 20e9, usedBytes: 19e9 },
        { mountPoint: "/", capacityBytes: 250e9, usedBytes: 1 },
      ],
    });
    const after = await db.select().from(storageVolumes).where(eq(storageVolumes.itemId, air));
    const sim = after.find((r) => r.mountPoint === SIM_IOS)!;
    expect(sim.usedBytes).toBe(5e9);
    expect(sim.source).toBe("legacy");
    expect(sim.measuredAt.getTime()).toBe(before!.measuredAt.getTime());
    expect(after.find((r) => r.mountPoint === "/")?.usedBytes).toBe(1);
  });
});

describe("storage.overview", () => {
  it("groups internal drives under their computer, externals apart, and falls back to attributes", async () => {
    const { houseId, pc, ssd, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: ssd, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 1000 * GB, usedBytes: 600 * GB }] });
    const o = await c.storage.overview({});
    expect(o.computers.map((x) => x.name)).toEqual(["mac-mini", "synology-nas"]);
    const mini = o.computers.find((x) => x.id === pc)!;
    expect(mini.drives.map((d) => [d.name, d.measured, d.usedBytes])).toEqual([["Internal SSD", true, 600 * GB]]);
    expect(mini.drives[0].volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    // the computer itself has no volumes: block from its attributes, unmeasured
    expect([mini.measured, mini.capacityBytes, mini.usedBytes]).toEqual([false, 1000e9, 600e9]);
    const nasBox = o.computers.find((d) => d.id === nas)!;
    expect([nasBox.kind, nasBox.measured, nasBox.capacityBytes, nasBox.usedBytes]).toEqual(["nas", false, 3933e9, (3933 - 426) * 1e9]);
    expect(o.externals.map((d) => d.id)).not.toContain(pc);
    expect(o.externals.map((d) => d.id)).not.toContain(ssd);
    expect(o.externals.map((d) => d.id)).not.toContain(nas);
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
    expect((await callerFor(h2).storage.overview({ houseId: null })).computers.map((c) => c.name).sort()).toEqual(["mac-mini", "pi-zomer", "synology-nas"]);
    expect((await callerFor(null).storage.overview({})).computers.map((c) => c.id)).toContain(pc);
  });
});

describe("storage.setFlags", () => {
  it("stars a computer so it sorts above unstarred ones, and hides without dropping volumes", async () => {
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: alpha }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "alpha-pi", attributes: { role: "sbc" } })
      .$returningId();
    const [{ id: zeta }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "zeta-box", attributes: { role: "server" } })
      .$returningId();
    const c = callerFor(houseId);
    await c.storage.report({ itemId: pc, source: "test", volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1 }] });

    const before = await c.storage.overview({});
    expect(before.computers.map((x) => [x.name, x.starred, x.hidden])).toEqual([
      ["alpha-pi", false, false],
      ["mac-mini", false, false],
      ["synology-nas", false, false],
      ["zeta-box", false, false],
    ]);

    expect(await c.storage.setFlags({ itemId: zeta, starred: true })).toEqual({ id: zeta, starred: true, hidden: false });
    expect(await c.storage.setFlags({ itemId: pc, hidden: true })).toEqual({ id: pc, starred: false, hidden: true });

    const o = await c.storage.overview({});
    expect(o.computers.map((x) => [x.name, x.starred, x.hidden])).toEqual([
      ["zeta-box", true, false],
      ["alpha-pi", false, false],
      ["mac-mini", false, true],
      ["synology-nas", false, false],
    ]);
    const mini = o.computers.find((x) => x.id === pc)!;
    expect(mini.volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    expect(mini.volumes[0].usedBytes).toBe(1);
    expect(o.capacityBytes).toBe(GB);

    await c.storage.report({ itemId: pc, source: "test", volumes: [{ mountPoint: "/", capacityBytes: 2 * GB, usedBytes: 3 }] });
    const afterReport = await c.storage.overview({});
    const still = afterReport.computers.find((x) => x.id === pc)!;
    expect([still.hidden, still.starred, still.volumes[0].capacityBytes]).toEqual([true, false, 2 * GB]);
    expect((await db.query.items.findFirst({ where: eq(items.id, pc) }))?.attributes?.["storage.hidden"]).toBe("yes");

    expect(await c.storage.setFlags({ itemId: zeta, starred: false })).toEqual({ id: zeta, starred: false, hidden: false });
    expect(await c.storage.setFlags({ itemId: pc, hidden: false })).toEqual({ id: pc, starred: false, hidden: false });
    expect((await c.storage.overview({})).computers.map((x) => x.name)).toEqual(["alpha-pi", "mac-mini", "synology-nas", "zeta-box"]);
    expect((await db.query.items.findFirst({ where: eq(items.id, pc) }))?.attributes?.["storage.hidden"]).toBeUndefined();
  });

  it("stars a NAS like a computer, and refuses furniture, a missing item, or no flag", async () => {
    const { houseId, nas, chair } = await seedDevices();
    const c = callerFor(houseId);
    expect(await c.storage.setFlags({ itemId: nas, hidden: true })).toEqual({ id: nas, starred: false, hidden: true });
    expect((await c.storage.overview({})).computers.find((x) => x.id === nas)?.hidden).toBe(true);
    await expect(c.storage.setFlags({ itemId: chair, starred: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.storage.setFlags({ itemId: 999999, starred: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(c.storage.setFlags({ itemId: chair })).rejects.toThrow();
    expect((await getTestDb().query.items.findFirst({ where: eq(items.id, nas) }))?.attributes?.["storage.hidden"]).toBe("yes");
  });
});

describe("physicalDiskKey", () => {
  it("strips /dev, partitions and APFS slices", () => {
    expect(physicalDiskKey("/dev/sda2", null)).toBe("sda");
    expect(physicalDiskKey("sdb1", null)).toBe("sdb");
    expect(physicalDiskKey("nvme0n1p1", null)).toBe("nvme0n1");
    expect(physicalDiskKey("mmcblk0p2", null)).toBe("mmcblk0");
    expect(physicalDiskKey("disk7s1", null)).toBe("disk7");
    expect(physicalDiskKey("disk9s1", "disk9")).toBe("disk9");
  });
});

describe("storage disk linking", () => {
  it("puts computer volumes onto the matching disk Thing and infers a disk with no Thing", async () => {
    const { areaId, houseId, pc, ssd } = await seedDevices();
    const db = getTestDb();
    await db.update(items).set({ attributes: { role: "storage", drive_type: "ssd", storage_gb: 232 } }).where(eq(items.id, ssd));
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "test",
      volumes: [
        { mountPoint: "/", device: "/dev/sda2", capacityBytes: 244 * GB, usedBytes: 100 * GB },
        { mountPoint: "/mnt/external", device: "/dev/sdb1", capacityBytes: 3940 * GB, usedBytes: 200 * GB },
      ],
    });
    const o = await c.storage.overview({});
    const mini = o.computers.find((x) => x.id === pc)!;
    expect(mini.drives.map((d) => [d.name, d.measured, d.measure, d.diskKey, d.volumes.map((v) => v.mountPoint)])).toEqual([
      ["Internal SSD", true, "measured", "sda", ["/"]],
    ]);
    expect(mini.inferredDisks.map((d) => [d.name, d.inferred, d.diskKey, d.volumes.map((v) => v.mountPoint)])).toEqual([
      ["sdb", true, "sdb", ["/mnt/external"]],
    ]);
    expect(mini.drives[0].volumes[0].usedBytes).toBe(100 * GB);
    expect(mini.inferredDisks[0].volumes[0].usedBytes).toBe(200 * GB);
    expect(await db.select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd))).toHaveLength(0);
  });

  it("uses storage.disk when size would match the wrong drive", async () => {
    const { areaId, houseId, pc, ssd } = await seedDevices();
    const db = getTestDb();
    await db.update(items).set({ attributes: { role: "storage", storage_gb: 232, "storage.disk": "sdb" } }).where(eq(items.id, ssd));
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "test",
      volumes: [
        { mountPoint: "/", device: "sda2", capacityBytes: 244 * GB, usedBytes: 10 * GB },
        { mountPoint: "/mnt/external", device: "sdb1", capacityBytes: 3940 * GB, usedBytes: 20 * GB },
      ],
    });
    const mini = (await c.storage.overview({})).computers.find((x) => x.id === pc)!;
    expect(mini.drives[0].diskKey).toBe("sdb");
    expect(mini.drives[0].volumes.map((v) => v.mountPoint)).toEqual(["/mnt/external"]);
    expect(mini.inferredDisks.map((d) => d.diskKey)).toEqual(["sda"]);
  });

  it("leaves two similar disks unlinked when one volume group is ambiguous, and setDiskLink pins one", async () => {
    const { areaId, houseId, pc, ssd } = await seedDevices();
    const db = getTestDb();
    const [{ id: ssd2 }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "System SSD", parentId: pc, attributes: { role: "storage", storage_gb: 256 } })
      .$returningId();
    await db.update(items).set({ name: "System SSD", attributes: { role: "storage", storage_gb: 256 } }).where(eq(items.id, ssd));
    const c = callerFor(houseId);
    await c.storage.report({ itemId: pc, source: "test", volumes: [{ mountPoint: "/", device: "sda2", capacityBytes: 256 * GB, usedBytes: 80 * GB }] });
    const before = (await c.storage.overview({})).computers.find((x) => x.id === pc)!;
    expect(before.inferredDisks.map((d) => d.diskKey)).toEqual(["sda"]);
    expect(before.unlinkedDisks?.map((d) => d.measure).sort()).toEqual(["unlinked", "unlinked"]);
    expect(before.drives.map((d) => d.measure).sort()).toEqual([]);
    expect(await c.storage.setDiskLink({ itemId: ssd, diskKey: "sda" })).toEqual({ id: ssd, diskKey: "sda" });
    const after = (await c.storage.overview({})).computers.find((x) => x.id === pc)!;
    expect(after.drives.find((d) => d.id === ssd)?.volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    expect(after.drives.find((d) => d.id === ssd2)?.measure).toBe("duplicate");
    expect(after.inferredDisks).toEqual([]);
  });

  it("labels an inventory-only disk as no collector when the computer has no volumes", async () => {
    const { houseId, pc, ssd } = await seedDevices();
    const mini = (await callerFor(houseId).storage.overview({})).computers.find((x) => x.id === pc)!;
    expect(mini.drives.map((d) => [d.id, d.measure, d.measured])).toEqual([[ssd, "no-collector", false]]);
    expect(mini.inferredDisks).toEqual([]);
  });

  it("maps Mini disk9 volumes onto an unattached Ugreen NVME by serial and hangs it under the machine", async () => {
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: ugreen }] = await db
      .insert(items)
      .values({
        areaId,
        houseId,
        name: "Ugreen NVME 1TB",
        attributes: { role: "storage", serial: "SNVS1000GB", model: "SNVS1000GB", storage_gb: 1000 },
      })
      .$returningId();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "local-script",
      volumes: [
        { mountPoint: "/Volumes/ExtNVMe", label: "ExtNVMe", device: "disk9s1", container: "disk9", capacityBytes: 1000 * GB, usedBytes: 400 * GB },
        { mountPoint: "/Volumes/NVMe", label: "NVMe", device: "disk9s2", container: "disk9", capacityBytes: 1000 * GB, usedBytes: 200 * GB },
        { mountPoint: "/Volumes/Reservekopieën van Rick's Mac mini 4", label: "Reservekopieën van Rick's Mac mini 4", device: "disk9s3", container: "disk9", capacityBytes: 1000 * GB, usedBytes: 100 * GB },
      ],
    });
    const o = await c.storage.overview({});
    const mini = o.computers.find((x) => x.id === pc)!;
    const disk = mini.attached.find((d) => d.id === ugreen);
    expect(disk).toMatchObject({ diskKey: "disk9", measured: true, measure: "measured" });
    expect(disk?.volumes.map((v) => v.mountPoint).sort()).toEqual([
      "/Volumes/ExtNVMe",
      "/Volumes/NVMe",
      "/Volumes/Reservekopieën van Rick's Mac mini 4",
    ]);
    expect(o.externals.map((d) => d.id)).not.toContain(ugreen);
    expect(mini.inferredDisks.map((d) => d.diskKey)).not.toContain("disk9");
  });

  it("hides a disk at the old machine when a newer sighting of the same serial exists elsewhere", async () => {
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: imac }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "rick-iMac5k", attributes: { role: "desktop", hostname: "rick-imac5k" } })
      .$returningId();
    const [{ id: t7 }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "PSSD T7", parentId: imac, attributes: { role: "storage", serial: "T7SERIAL", storage_gb: 4000 } })
      .$returningId();
    const c = callerFor(houseId);
    const old = new Date("2026-08-01T12:00:00Z");
    const fresh = new Date("2026-10-15T12:00:00Z");
    await c.storage.report({
      itemId: imac,
      source: "test",
      volumes: [{ mountPoint: "/Volumes/T7", label: "T7", device: "disk7s1", container: "disk7", capacityBytes: 4000 * GB, usedBytes: 2000 * GB, measuredAt: old }],
    });
    await c.storage.report({
      itemId: pc,
      source: "test",
      volumes: [{ mountPoint: "/Volumes/T7", label: "T7", device: "disk7s1", container: "disk7", capacityBytes: 4000 * GB, usedBytes: 2100 * GB, measuredAt: fresh }],
    });
    await db.update(items).set({ attributes: { role: "storage", serial: "T7SERIAL", storage_gb: 4000, "storage.disk": "disk7" } }).where(eq(items.id, t7));
    const [{ id: t7mini }] = await db
      .insert(items)
      .values({
        areaId,
        houseId,
        name: "PSSD T7 mini",
        parentId: pc,
        attributes: { role: "storage", serial: "T7SERIAL", storage_gb: 4000, "storage.disk": "disk7" },
      })
      .$returningId();
    const o = await c.storage.overview({});
    const mini = o.computers.find((x) => x.id === pc)!;
    const oldMac = o.computers.find((x) => x.id === imac)!;
    expect(mini.drives.find((d) => d.id === t7mini)?.volumes.map((v) => v.mountPoint)).toEqual(["/Volumes/T7"]);
    expect(oldMac.drives.find((d) => d.id === t7)?.volumes.length ?? 0).toBe(0);
    expect(oldMac.drives.map((d) => d.id)).not.toContain(t7);
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

describe("storage.reportDirs", () => {
  it("replaces folders on an existing volume without touching capacity or use", async () => {
    const { houseId, pc } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "local-script",
      volumes: [{ mountPoint: "/", capacityBytes: 10 * GB, usedBytes: 4 * GB, dirs: [{ path: "/old", bytes: GB }] }],
    });
    const before = (await getTestDb().select().from(storageVolumes))[0];
    const out = await c.storage.reportDirs({
      itemId: pc,
      source: "file-inventory",
      volumes: [
        {
          mountPoint: "/",
          dirs: [
            { path: "/Users", bytes: 3 * GB },
            { path: "/Users", bytes: 2 * GB },
            { path: "/Applications", bytes: GB },
          ],
        },
        { mountPoint: "/Volumes/ghost", dirs: [{ path: "/Volumes/ghost/x", bytes: GB }] },
      ],
    });
    expect(out).toMatchObject({ itemId: pc, itemName: "mac-mini", volumes: 1, dirs: 2, skipped: [{ mountPoint: "/Volumes/ghost", reason: "no matching volume" }] });
    const after = (await getTestDb().select().from(storageVolumes))[0];
    expect([after.capacityBytes, after.usedBytes, after.source, after.measuredAt.getTime()]).toEqual([
      before.capacityBytes,
      before.usedBytes,
      "local-script",
      before.measuredAt.getTime(),
    ]);
    const listed = await c.storage.dirs({ volumeId: after.id });
    expect(listed.dirs.map((d) => [d.path, d.bytes])).toEqual([
      ["/Users", 3 * GB],
      ["/Applications", GB],
    ]);
  });

  it("finds the machine by hostname and clears dirs with an empty list", async () => {
    const { houseId, pc } = await seedDevices();
    const db = getTestDb();
    await db.update(items).set({ attributes: { role: "desktop", hostname: "macmini-m4" } }).where(eq(items.id, pc));
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "test",
      volumes: [{ mountPoint: "/", capacityBytes: GB, usedBytes: 1, dirs: [{ path: "/Users", bytes: 1 }] }],
    });
    const cleared = await c.storage.reportDirs({
      host: "macmini-m4.local",
      source: "file-inventory",
      volumes: [{ mountPoint: "/", dirs: [] }],
    });
    expect(cleared).toMatchObject({ itemId: pc, volumes: 1, dirs: 0, skipped: [] });
    const v = (await db.select().from(storageVolumes))[0];
    expect((await c.storage.dirs({ volumeId: v.id })).dirs).toEqual([]);
  });

  it("refuses furniture, a missing host, and a report with neither itemId nor host", async () => {
    const { houseId, chair } = await seedDevices();
    const c = callerFor(houseId);
    await expect(
      c.storage.reportDirs({ itemId: chair, source: "file-inventory", volumes: [{ mountPoint: "/", dirs: [] }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      c.storage.reportDirs({ host: "no-such-box", source: "file-inventory", volumes: [{ mountPoint: "/", dirs: [] }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      c.storage.reportDirs({ source: "file-inventory", volumes: [{ mountPoint: "/", dirs: [] }] } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
  const nasDisk = (o: Awaited<ReturnType<ReturnType<typeof callerFor>["storage"]["overview"]>>, nasId: number) => {
    const box = o.computers.find((x) => x.id === nasId)!;
    return box.inferredDisks[0] ?? box.drives[0];
  };

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
    const d = nasDisk(o, nas);
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
    const d = nasDisk(o, nas);
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
    const d = nasDisk(await c.storage.overview({}), nas);
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
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: usb }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "USB disk", attributes: { role: "storage" } })
      .$returningId();
    const c = callerFor(houseId);
    const { id: relId } = await c.items.addRelation({ fromItemId: usb, toItemId: pc, type: "attached-to" });
    const o = await c.storage.overview({});
    const mac = o.computers.find((x) => x.id === pc)!;
    expect(mac.attached.map((d) => [d.id, d.attachedRelationId])).toEqual([[usb, relId]]);
    expect(mac.drives.map((d) => d.attachedRelationId)).toEqual([null]);
    expect(o.externals.map((d) => d.id)).not.toContain(usb);
  });

  it("keeps the drive external when its computer is archived", async () => {
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: usb }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "USB disk", attributes: { role: "storage" } })
      .$returningId();
    const c = callerFor(houseId);
    const { id: relId } = await c.items.addRelation({ fromItemId: usb, toItemId: pc, type: "attached-to" });
    await db.update(items).set({ status: "archived" }).where(eq(items.id, pc));
    const o = await c.storage.overview({});
    expect(o.computers.map((x) => x.id)).not.toContain(pc);
    expect(o.computers.every((x) => x.attached.length === 0)).toBe(true);
    const d = o.externals.find((x) => x.id === usb);
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
    const d = o.computers.find((x) => x.id === nas)!;
    expect(d.backsUp).toEqual([
      { relationId: r1.id, itemId: pc, name: "mac-mini" },
      { relationId: r2.id, itemId: phone, name: "iPhone" },
    ]);
    expect(o.computers.find((x) => x.id === pc)!.backsUp).toEqual([]);
  });
});

describe("storage.setIdentity", () => {
  it("pins machine.id from a hostname already on the computer", async () => {
    const { houseId, pc } = await seedDevices();
    const db = getTestDb();
    await db.update(items).set({ attributes: { role: "desktop", hostname: "macmini-m4", ip: "10.50.0.102" } }).where(eq(items.id, pc));
    const c = callerFor(houseId);
    expect(await c.storage.setIdentity({ itemId: pc, machineId: "macmini-m4" })).toEqual({ id: pc, machineId: "macmini-m4" });
    const o = await c.storage.overview({});
    expect(o.computers.find((x) => x.id === pc)?.machineId).toBe("macmini-m4");
    expect(await c.storage.setIdentity({ itemId: pc, machineId: null })).toEqual({ id: pc, machineId: null });
  });

  it("refuses a value that is not a hostname, IP, MAC or alias on the machine", async () => {
    const { houseId, pc, chair } = await seedDevices();
    const c = callerFor(houseId);
    await expect(c.storage.setIdentity({ itemId: pc, machineId: "rick-iMac21-3" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.storage.setIdentity({ itemId: chair, machineId: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("NAS machine card", () => {
  it("shows NAS volumes as disks on the NAS card, not as an unattached external", async () => {
    const { houseId, nas } = await seedDevices();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: nas,
      source: "data-tracker",
      volumes: [
        { mountPoint: "/", device: "md0", capacityBytes: 8 * GB, usedBytes: 2 * GB },
        { mountPoint: "/volume1", device: "md2", capacityBytes: 3000 * GB, usedBytes: 2000 * GB },
      ],
    });
    const o = await c.storage.overview({});
    const box = o.computers.find((x) => x.id === nas)!;
    expect(box.kind).toBe("nas");
    expect(box.inferredDisks.map((d) => [d.diskKey, d.volumes.map((v) => v.mountPoint)])).toEqual([
      ["md0", ["/"]],
      ["md2", ["/volume1"]],
    ]);
    expect(o.externals.map((d) => d.id)).not.toContain(nas);
  });
});

describe("volume identity", () => {
  it("treats label vs path and UUID vs / as the same volume", () => {
    expect(sameVolume({ mountPoint: "/media/rick/NVMe", capacityBytes: 1e12 }, { mountPoint: "NVMe", label: "NVMe", capacityBytes: 1e12 })).toBe(true);
    expect(
      sameVolume(
        { mountPoint: "/", device: "/dev/sda2", capacityBytes: 236e9 },
        { mountPoint: "F28675F98ABCDEF0", device: "sda2", capacityBytes: 236e9 },
      ),
    ).toBe(true);
    expect(
      sameVolume(
        { mountPoint: "/", device: "sda2", capacityBytes: 236e9 },
        { mountPoint: "F28675F98ABCDEF0", device: "sda1", capacityBytes: 236e9 },
      ),
    ).toBe(false);
    expect(sameVolume({ mountPoint: "/", device: "sda2", capacityBytes: 236e9 }, { mountPoint: "F28675F98ABCDEF0", capacityBytes: 236e9 })).toBe(true);
    expect(sameVolume({ mountPoint: "/mnt/backup", device: "/dev/sdb2" }, { mountPoint: "/mnt/backup", device: "sdb2" })).toBe(true);
    expect(sameVolume({ mountPoint: "/", device: "sda2" }, { mountPoint: "/mnt/backup", device: "sdb2" })).toBe(false);
    expect(
      sameVolume(
        { mountPoint: "/", device: "/dev/disk3s5", capacityBytes: 500e9 },
        { mountPoint: "/System/Volumes/Data", device: "disk3s5", capacityBytes: 500e9 },
      ),
    ).toBe(false);
    expect(volumeDedupeIsSafe({ mountPoint: "/" }, { mountPoint: "/System/Volumes/Data" })).toBe(false);
    expect(
      volumeDedupeIsSafe({ mountPoint: "/", device: "sda2" }, { mountPoint: "F28675F98ABCDEF0", device: "sda2" }),
    ).toBe(true);
    expect(
      sameVolume(
        { mountPoint: "/Volumes/T7", label: "T7", capacityBytes: 1000 * 1024 ** 3 },
        { mountPoint: "/Volumes/TM-T7", label: "TM-T7", capacityBytes: 1000 * 1024 ** 3 },
      ),
    ).toBe(false);
  });

  it("clusters an enclosure Thing with the inner drive via volume leaf + size, not a smaller Elements", () => {
    const enclosure = {
      name: "Elements 25A3 11TB",
      capacityBytes: 12000e9,
      volumes: [] as Array<{ label?: string | null; mountPoint: string }>,
    };
    const inner = {
      name: "WDC WD120EDAZ-11F3RA0",
      capacityBytes: 12000e9,
      serial: "WD-WX12",
      volumes: [{ label: "Elements", mountPoint: "/media/rick/Elements" }],
    };
    const stale = {
      name: "Elements 1042",
      capacityBytes: 1000e9,
      volumes: [{ label: "Extern", mountPoint: "/media/rick/Extern" }],
    };
    const inferred = {
      name: "sde1",
      capacityBytes: 12000e9,
      volumes: [{ label: "Elements", mountPoint: "/media/rick/Elements" }],
    };
    const groups = clusterByTwinKeys([enclosure, inner, stale, inferred], (d) => machineTwinKeys(d));
    const twelve = groups.find((g) => g.includes(inner))!;
    expect(twelve).toEqual(expect.arrayContaining([enclosure, inner, inferred]));
    expect(twelve).not.toContain(stale);
    expect(groups.find((g) => g.includes(stale))).toEqual([stale]);
  });
});

describe("machine volume upsert and overview dedupe", () => {
  const DEC = 1e9;

  it("upserts Mini/computer /mnt/backup onto the existing disk-Thing row and shows physical disk size", async () => {
    const { areaId, houseId, pc } = await seedDevices();
    const db = getTestDb();
    const [{ id: disk }] = await db
      .insert(items)
      .values({
        areaId,
        houseId,
        name: "ST9500420ASG",
        parentId: pc,
        attributes: { role: "storage", model: "ST9500420ASG", serial: "5VJCQK0M", storage_gb: 500, size_bytes: 500107862016 },
      })
      .$returningId();
    const old = new Date("2026-10-15T12:00:00Z");
    const fresh = new Date("2026-10-16T12:00:00Z");
    await db.insert(storageVolumes).values({
      itemId: disk,
      mountPoint: "/mnt/backup",
      device: "/dev/sdb2",
      capacityBytes: 490.8 * DEC,
      usedBytes: 358.5 * DEC,
      source: "legacy",
      measuredAt: old,
    });
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: pc,
      source: "data-tracker",
      volumes: [
        {
          mountPoint: "/mnt/backup",
          label: "backup",
          device: "/dev/sdb2",
          capacityBytes: 490.8 * DEC,
          usedBytes: 358.5 * DEC,
          measuredAt: fresh,
        },
      ],
    });
    const rows = await db.select().from(storageVolumes);
    const backups = rows.filter((r) => r.mountPoint === "/mnt/backup");
    expect(backups).toHaveLength(1);
    expect(backups[0].itemId).toBe(pc);
    expect(backups[0].measuredAt.getTime()).toBe(fresh.getTime());
    const o = await c.storage.overview({});
    const mini = o.computers.find((x) => x.id === pc)!;
    const shown = [...mini.drives, ...mini.inferredDisks].find((d) => d.volumes.some((v) => v.mountPoint === "/mnt/backup"))!;
    expect(shown.volumes).toHaveLength(1);
    expect(shown.capacityBytes).toBe(500107862016);
    expect(shown.usedBytes).toBe(358.5 * DEC);
  });

  it("does not let an older tracker report overwrite a fresher measurement of /", async () => {
    const { houseId, pc } = await seedDevices();
    const c = callerFor(houseId);
    const fresh = new Date("2026-10-16T08:00:00Z");
    const old = new Date("2026-10-04T08:00:00Z");
    await c.storage.report({
      itemId: pc,
      source: "local-script",
      volumes: [{ mountPoint: "/", device: "disk3s1", capacityBytes: 500 * DEC, usedBytes: 200 * DEC, measuredAt: fresh }],
    });
    await c.storage.report({
      itemId: pc,
      source: "data-tracker",
      volumes: [{ mountPoint: "/", device: "/dev/sda2", capacityBytes: 500 * DEC, usedBytes: 10 * DEC, measuredAt: old }],
    });
    const row = (await getTestDb().select().from(storageVolumes)).find((v) => v.mountPoint === "/")!;
    expect(row.usedBytes).toBe(200 * DEC);
    expect(row.measuredAt.getTime()).toBe(fresh.getTime());
    expect(row.source).toBe("local-script");
  });

  it("dedupes OptiPlex path-vs-label and UUID segments, collapses enclosure vs inner drive, hides network shares, and lists unlinked disks", async () => {
    const { areaId, houseId } = await seedDevices();
    const db = getTestDb();
    const [{ id: opti }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "OptiPlex 990", attributes: { role: "desktop", hostname: "optiplex-990" } })
      .$returningId();
    const addDisk = async (name: string, attrs: Record<string, string | number>, parent?: number | null) => {
      const [{ id }] = await db.insert(items).values({ areaId, houseId, name, parentId: parent === undefined ? opti : parent, attributes: { role: "storage", ...attrs } }).$returningId();
      return id;
    };
    const kingston = await addDisk("Kingston SV300S37A240G", { model: "SV300S37A240G", storage_gb: 236 });
    const toshiba = await addDisk("Toshiba DT01ACA100", { model: "DT01ACA100", storage_gb: 2000 });
    const sn570 = await addDisk("WD Blue SN570 1TB", { model: "SN570", storage_gb: 1000 });
    const elements = await addDisk("Elements 25A3 11TB", { model: "Elements 25A3", storage_gb: 12000 });
    const wdc = await addDisk("WDC WD120EDAZ-11F3RA0", { model: "WD120EDAZ-11F3RA0", serial: "WD-WX12", storage_gb: 12000 }, null);
    const elementsSmall = await addDisk("Elements 1042", { model: "Elements 1042", storage_gb: 1000 }, null);
    await addDisk("Generic USB 606GB", { storage_gb: 606 });
    await addDisk("Network Share BackupFTP", { storage_gb: 3600 });
    await db.insert(relations).values([
      { fromItemId: wdc, toItemId: opti, type: "attached-to", origin: "user", status: "confirmed" },
      { fromItemId: elementsSmall, toItemId: opti, type: "attached-to", origin: "user", status: "confirmed" },
    ]);
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: opti,
      source: "test",
      volumes: [
        { mountPoint: "/", device: "sda2", capacityBytes: 236 * DEC, usedBytes: 113 * DEC },
        { mountPoint: "/media/rick/NVMe", label: "NVMe", device: "nvme0n1p1", capacityBytes: 1000 * DEC, usedBytes: 560 * DEC },
        { mountPoint: "/media/rick/Elements", label: "Elements", device: "sde1", capacityBytes: 12000 * DEC, usedBytes: 3840 * DEC },
        { mountPoint: "/mnt/toshiba", device: "sdb1", capacityBytes: 2000 * DEC, usedBytes: 60 * DEC },
      ],
    });
    await db.insert(storageVolumes).values([
      { itemId: kingston, mountPoint: "F28675F98ABCDEF0", device: "sda2", capacityBytes: 236 * DEC, usedBytes: 113 * DEC, source: "legacy", measuredAt: new Date("2026-10-01") },
      { itemId: sn570, mountPoint: "NVMe", label: "NVMe", device: "nvme0n1p1", capacityBytes: 1000 * DEC, usedBytes: 560 * DEC, source: "legacy", measuredAt: new Date("2026-10-01") },
      { itemId: toshiba, mountPoint: "/mnt/toshiba", device: "/dev/sdb1", capacityBytes: 2000 * DEC, usedBytes: 60 * DEC, source: "legacy", measuredAt: new Date("2026-10-01") },
      { itemId: wdc, mountPoint: "/media/rick/Elements", label: "Elements", device: "sde1", capacityBytes: 12000 * DEC, usedBytes: 3840 * DEC, source: "legacy", measuredAt: new Date("2026-10-01") },
      { itemId: elementsSmall, mountPoint: "/media/rick/Extern", label: "Extern", device: "sdf1", capacityBytes: 1000 * DEC, usedBytes: 370 * DEC, source: "legacy", measuredAt: new Date("2026-10-09") },
    ]);
    const o = await c.storage.overview({});
    const box = o.computers.find((x) => x.id === opti)!;
    const kingstonDisk = [...box.drives, ...box.attached].find((d) => d.id === kingston)!;
    expect(kingstonDisk.volumes).toHaveLength(1);
    expect(kingstonDisk.capacityBytes).toBe(236 * DEC);
    const nvmeDisk = [...box.drives, ...box.attached].find((d) => d.id === sn570)!;
    expect(nvmeDisk.volumes).toHaveLength(1);
    expect(nvmeDisk.capacityBytes).toBe(1000 * DEC);
    expect(nvmeDisk.volumes[0].mountPoint === "/media/rick/NVMe" || nvmeDisk.volumes[0].label === "NVMe").toBe(true);
    const toshibaDisk = [...box.drives, ...box.attached].find((d) => d.id === toshiba)!;
    expect(toshibaDisk.volumes).toHaveLength(1);
    const twelveTb = [...box.drives, ...box.attached, ...box.inferredDisks].filter((d) => Math.round((d.capacityBytes ?? 0) / DEC) === 12000);
    expect(twelveTb).toHaveLength(1);
    expect(twelveTb[0].volumes).toHaveLength(1);
    expect(twelveTb[0].id).not.toBe(elementsSmall);
    const staleElements = box.attached.find((d) => d.id === elementsSmall);
    expect(staleElements).toBeTruthy();
    expect(Math.round((staleElements!.capacityBytes ?? 0) / DEC)).toBe(1000);
    expect(box.remoteMounts?.some((d) => /backupftp/i.test(d.name))).toBe(true);
    expect(box.unlinkedDisks?.some((d) => /generic usb/i.test(d.name))).toBe(true);
    const plan = await c.storage.dedupeVolumes({ dry: true });
    expect(plan.dry).toBe(true);
    expect(plan.droppedVolumes).toBe(0);
    expect(plan.volumes.length).toBeGreaterThan(0);
    expect(plan.diskMerges.some((m) => m.drop.some((d) => d.id === wdc) || m.keep.id === wdc)).toBe(true);
    const applied = await c.storage.dedupeVolumes({ dry: false });
    expect(applied.droppedVolumes).toBeGreaterThan(0);
    expect(applied.volumes.filter((g) => g.ambiguous)).toEqual([]);
    const again = await c.storage.dedupeVolumes({ dry: false });
    expect(again.droppedVolumes).toBe(0);
  });

  it("does not treat APFS / and /System/Volumes/Data as one volume, hides Data on the overview, and still drops true dupes", async () => {
    const { houseId, pc, ssd } = await seedDevices();
    const c = callerFor(houseId);
    const db = getTestDb();
    await c.storage.report({
      itemId: pc,
      source: "local-script",
      volumes: [
        { mountPoint: "/", device: "/dev/disk3s5", container: "disk3", capacityBytes: 500 * DEC, usedBytes: 200 * DEC },
        { mountPoint: "/System/Volumes/Data", device: "/dev/disk3s5", container: "disk3", capacityBytes: 500 * DEC, usedBytes: 200 * DEC },
      ],
    });
    const [{ id: leftover }] = await db.insert(storageVolumes).values({
      itemId: ssd,
      mountPoint: "/",
      device: "disk3s5",
      container: "disk3",
      capacityBytes: 500 * DEC,
      usedBytes: 180 * DEC,
      source: "legacy",
      measuredAt: new Date("2026-10-01"),
    }).$returningId();
    const o = await c.storage.overview({});
    const mini = o.computers.find((x) => x.id === pc)!;
    const rootDisk = [...mini.drives, ...mini.inferredDisks].find((d) => d.volumes.some((v) => v.mountPoint === "/"));
    expect(rootDisk).toBeTruthy();
    expect(rootDisk!.volumes.map((v) => v.mountPoint)).toEqual(["/"]);
    expect(rootDisk!.volumes.some((v) => v.mountPoint === "/System/Volumes/Data")).toBe(false);
    const plan = await c.storage.dedupeVolumes({ dry: true, mergeDisks: true });
    expect(plan.volumes.some((g) => g.drop.some((d) => d.mountPoint === "/System/Volumes/Data") || g.keep.mountPoint === "/System/Volumes/Data")).toBe(false);
    expect(plan.volumes.some((g) => g.keep.mountPoint === "/" || g.drop.some((d) => d.mountPoint === "/"))).toBe(true);
    expect(plan.volumes.every((g) => !g.ambiguous)).toBe(true);
    const applied = await c.storage.dedupeVolumes({ dry: false });
    expect(applied.droppedVolumes).toBeGreaterThan(0);
    expect(applied.skippedVolumes).toBe(0);
    const rows = await db.select().from(storageVolumes);
    expect(rows.some((r) => r.id === leftover)).toBe(false);
    expect(rows.filter((r) => r.mountPoint === "/")).toHaveLength(1);
    expect(rows.some((r) => r.mountPoint === "/System/Volumes/Data")).toBe(true);
  });

  it("offers a merge of an import-created inner drive with the enclosure on the same machine", async () => {
    const { areaId, houseId } = await seedDevices();
    const db = getTestDb();
    const [{ id: opti }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "OptiPlex 990", attributes: { role: "desktop", hostname: "optiplex-990" } })
      .$returningId();
    const [{ id: enclosure }] = await db
      .insert(items)
      .values({ areaId, houseId, name: "Elements 25A3 11TB", parentId: opti, attributes: { role: "storage", model: "Elements 25A3", storage_gb: 12000 } })
      .$returningId();
    const [{ id: inner }] = await db
      .insert(items)
      .values({
        areaId,
        houseId,
        name: "WDC WD120EDAZ-11F3RA0",
        parentId: null,
        attributes: { role: "storage", model: "WD120EDAZ-11F3RA0", serial: "5PH4Z28D", storage_gb: 12000, "storage.disk": "sde" },
        verificationStatus: "detected",
      })
      .$returningId();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: opti,
      source: "test",
      volumes: [{ mountPoint: "/media/rick/Elements", label: "Elements", device: "sde1", capacityBytes: 12000 * DEC, usedBytes: 3840 * DEC }],
    });
    const plan = await c.storage.dedupeVolumes({ dry: true, mergeDisks: true });
    expect(plan.diskMerges.some((m) => m.machineId === opti && (m.keep.id === inner || m.drop.some((d) => d.id === inner)) && (m.keep.id === enclosure || m.drop.some((d) => d.id === enclosure)))).toBe(true);
  });
});
