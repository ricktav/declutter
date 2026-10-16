import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, relations, storageDirs, storageVolumes } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import {
  DEFAULT_TRACKER_HOST_MAP,
  parseTrackerSize,
  parseTrackerSources,
  planTrackerImport,
  type InventoryItem,
} from "../lib/storageTracker";

beforeEach(resetTestDb);

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/data-tracker-sources.json"), "utf8"));

describe("parseTrackerSources", () => {
  it("reads disk and volume file sources and skips other types", () => {
    const parsed = parseTrackerSources(fixture);
    expect(parsed.skipped).toBe(1);
    expect(parsed.disks.map((d) => d.name).sort()).toEqual([
      "Mac:disk3",
      "dockermac-2:sda",
      "dockermac:sda",
      "dockermac:sdb",
      "plugwise-pi:mmcblk0",
    ]);
    const sda = parsed.disks.find((d) => d.name === "dockermac:sda")!;
    expect(sda).toMatchObject({
      host: "dockermac",
      diskKey: "sda",
      model: "Samsung SSD 850",
      serial: "S21PNXBG996622H",
      sizeBytes: 250e9,
    });
    const root = parsed.volumes.find((v) => v.host === "dockermac" && v.mountPoint === "/")!;
    expect(root).toMatchObject({
      device: "/dev/sda2",
      fsType: "ext4",
      capacityBytes: 244e9,
      usedBytes: 170e9,
      diskKey: "sda",
    });
    const ext = parsed.volumes.find((v) => v.mountPoint === "/mnt/external")!;
    expect(ext.capacityBytes).toBe(3.94e12);
    expect(ext.usedBytes).toBe(3.11e12);
    expect(ext.diskKey).toBe("sdb");
  });

  it("parses human sizes and small numbers as GB", () => {
    expect(parseTrackerSize("250GB")).toBe(250e9);
    expect(parseTrackerSize("4.0TB")).toBe(4e12);
    expect(parseTrackerSize("500MB")).toBe(500e6);
    expect(parseTrackerSize(244e9)).toBe(244e9);
    expect(parseTrackerSize(32)).toBe(32e9);
  });
});

describe("planTrackerImport host map", () => {
  it("maps dockermac and plugwise-pi, and skips stale Mac", () => {
    const parsed = parseTrackerSources(fixture);
    const inventory: InventoryItem[] = [
      { id: 201, name: "dockermac-1", areaId: 1, houseId: 1, roomId: null, parentId: null, attributes: { role: "desktop", hostname: "dockermac-1" } },
      { id: 226, name: "Samsung SSD 850 232GB", areaId: 1, houseId: 1, roomId: null, parentId: 201, attributes: { role: "storage", serial: "S21PNXBG996622H", storage_gb: 232 } },
      { id: 301, name: "dockermac-2", areaId: 1, houseId: 1, roomId: null, parentId: null, attributes: { role: "desktop", hostname: "dockermac-2" } },
      { id: 227, name: "Crucial MX500", areaId: 1, houseId: 1, roomId: null, parentId: 301, attributes: { role: "storage", model: "Crucial MX500", storage_gb: 500 } },
      { id: 40, name: "plugwisepi", areaId: 1, houseId: 1, roomId: null, parentId: null, attributes: { role: "sbc", hostname: "plugwisepi" } },
      { id: 9, name: "Mac", areaId: 1, houseId: 1, roomId: null, parentId: null, attributes: { role: "laptop", hostname: "Mac" } },
    ];
    const plan = planTrackerImport(parsed, inventory, [], DEFAULT_TRACKER_HOST_MAP, true);
    const byHost = Object.fromEntries(plan.hosts.map((h) => [h.host, h]));
    expect(byHost.dockermac.status).toBe("matched");
    expect(byHost.dockermac.itemId).toBe(201);
    expect(byHost.dockermac.disks.find((d) => d.diskKey === "sda")).toMatchObject({ match: "serial", itemId: 226 });
    expect(byHost.dockermac.disks.find((d) => d.diskKey === "sdb")).toMatchObject({ match: "create", itemId: null, name: "Portable" });
    expect(byHost.dockermac.volumes.map((v) => v.mountPoint).sort()).toEqual(["/", "/boot/efi", "/mnt/external"]);
    expect(byHost["dockermac-2"].disks[0]).toMatchObject({ match: "model-size", itemId: 227 });
    expect(byHost["plugwise-pi"].itemId).toBe(40);
    expect(byHost["plugwise-pi"].disks[0].match).toBe("create");
    expect(byHost.Mac.status).toBe("skipped");
    expect(byHost.Mac.volumes).toEqual([]);
  });
});

async function seedTrackerHouse() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: dm1 }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "dockermac-1", attributes: { role: "desktop", hostname: "dockermac-1" } })
    .$returningId();
  const [{ id: ssd }] = await db
    .insert(items)
    .values({
      areaId,
      houseId,
      name: "Samsung SSD 850 232GB",
      parentId: dm1,
      attributes: { role: "storage", drive_type: "ssd", serial: "S21PNXBG996622H", storage_gb: 232 },
    })
    .$returningId();
  const [{ id: dm2 }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "dockermac-2", attributes: { role: "desktop", hostname: "dockermac-2" } })
    .$returningId();
  const [{ id: mx }] = await db
    .insert(items)
    .values({
      areaId,
      houseId,
      name: "Crucial MX500",
      parentId: dm2,
      attributes: { role: "storage", model: "Crucial MX500", storage_gb: 500 },
    })
    .$returningId();
  const [{ id: pi }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "plugwisepi", attributes: { role: "sbc", hostname: "plugwisepi" } })
    .$returningId();
  const [{ id: staleMac }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "Mac", attributes: { role: "laptop", hostname: "Mac" } })
    .$returningId();
  return { areaId, houseId, dm1, ssd, dm2, mx, pi, staleMac };
}

describe("storage.importSources", () => {
  it("dry-run writes nothing", async () => {
    const { houseId } = await seedTrackerHouse();
    const c = callerFor(houseId);
    const plan = await c.storage.importSources({ sources: fixture, dry: true });
    expect(plan.dry).toBe(true);
    expect(plan.applied).toEqual({ reports: 0, volumes: 0, diskLinks: 0, created: 0 });
    expect(await getTestDb().select().from(storageVolumes)).toHaveLength(0);
    expect(plan.hosts.find((h) => h.host === "Mac")?.status).toBe("skipped");
  });

  it("applies reports onto the computer, links by serial, and creates an unmatched disk", async () => {
    const { houseId, dm1, ssd } = await seedTrackerHouse();
    const c = callerFor(houseId);
    const result = await c.storage.importSources({ sources: fixture, dry: false });
    expect(result.dry).toBe(false);
    expect(result.applied.reports).toBeGreaterThanOrEqual(3);
    expect(result.applied.created).toBeGreaterThanOrEqual(1);

    const ssdRow = await getTestDb().query.items.findFirst({ where: eq(items.id, ssd) });
    expect(ssdRow?.attributes?.["storage.disk"]).toBe("sda");

    const vols = await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, dm1));
    expect(vols.map((v) => v.mountPoint).sort()).toEqual(["/", "/boot/efi", "/mnt/external"]);
    expect(vols.find((v) => v.mountPoint === "/")?.device).toBe("/dev/sda2");
    expect(await getTestDb().select().from(storageVolumes).where(eq(storageVolumes.itemId, ssd))).toHaveLength(0);

    const portable = (await getTestDb().select().from(items)).find((i) => i.name === "Portable");
    expect(portable).toBeTruthy();
    expect(portable?.parentId).toBeNull();
    expect(portable?.attributes?.["storage.disk"]).toBe("sdb");
    expect(portable?.verificationStatus).toBe("detected");
    const rel = await getTestDb()
      .select()
      .from(relations)
      .where(eq(relations.fromItemId, portable!.id));
    expect(rel).toEqual([expect.objectContaining({ toItemId: dm1, type: "attached-to", status: "confirmed" })]);

    const o = await c.storage.overview({});
    const machine = o.computers.find((x) => x.id === dm1)!;
    expect(machine.drives.find((d) => d.id === ssd)?.volumes.map((v) => v.mountPoint).sort()).toEqual(["/", "/boot/efi"]);
    expect(machine.attached.find((d) => d.id === portable!.id)?.volumes.map((v) => v.mountPoint)).toEqual(["/mnt/external"]);
    expect(machine.inferredDisks).toEqual([]);
  });

  it("keeps local-script directories when the tracker report omits dirs", async () => {
    const { houseId, dm1 } = await seedTrackerHouse();
    const c = callerFor(houseId);
    await c.storage.report({
      itemId: dm1,
      source: "local-script",
      volumes: [
        {
          mountPoint: "/",
          device: "/dev/sda2",
          capacityBytes: 244e9,
          usedBytes: 160e9,
          dirs: [
            { path: "/home", bytes: 80e9 },
            { path: "/var", bytes: 20e9 },
          ],
        },
      ],
    });
    await c.storage.importSources({ sources: fixture, dry: false });
    const vol = await getTestDb().query.storageVolumes.findFirst({
      where: eq(storageVolumes.mountPoint, "/"),
    });
    expect(vol?.source).toBe("data-tracker");
    expect(vol?.usedBytes).toBe(170e9);
    const dirs = await getTestDb().select().from(storageDirs).where(eq(storageDirs.volumeId, vol!.id));
    expect(dirs.map((d) => d.path).sort()).toEqual(["/home", "/var"]);
  });

  it("does not overwrite a manual storage.disk override", async () => {
    const { houseId, ssd } = await seedTrackerHouse();
    const c = callerFor(houseId);
    await c.storage.setDiskLink({ itemId: ssd, diskKey: "sdb" });
    await c.storage.importSources({ sources: fixture, dry: false });
    const row = await getTestDb().query.items.findFirst({ where: eq(items.id, ssd) });
    expect(row?.attributes?.["storage.disk"]).toBe("sdb");
    const o = await c.storage.overview({});
    const machine = o.computers.find((x) => x.name === "dockermac-1")!;
    expect(machine.drives.find((d) => d.id === ssd)?.diskKey).toBe("sdb");
  });
});
