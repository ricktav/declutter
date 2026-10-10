import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(resetTestDb);

async function seed() {
  const db = getTestDb();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: pc }] = await db
    .insert(items)
    .values({ areaId, houseId, name: "dockermac-1", attributes: { role: "desktop", hostname: "dockermac-1" } })
    .$returningId();
  const [{ id: chair }] = await db.insert(items).values({ areaId, houseId, name: "Stoel", attributes: { role: "furniture" } }).$returningId();
  return { houseId, pc, chair };
}

describe("services.report", () => {
  it("writes containers JSON onto a machine and replaces the next snapshot", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    const first = await c.services.report({
      itemId: pc,
      source: "test",
      containers: [
        { name: "nginx", status: "running", port: 80 },
        { name: "caddy", status: "running" },
      ],
    });
    expect(first).toEqual({ containers: 2, node: 0, web: 0, vms: 0, lxc: 0, databases: 0, projects: 0 });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.containers))).toEqual([
      { name: "nginx", status: "running", port: 80 },
      { name: "caddy", status: "running" },
    ]);
    await c.services.report({ itemId: pc, source: "test", containers: [{ name: "nginx" }] });
    const [after] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(after.attributes?.containers))).toEqual([{ name: "nginx" }]);
  });

  it("clears a list when the report sends an empty array, and leaves omitted keys", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({
      itemId: pc,
      source: "test",
      containers: [{ name: "nginx" }],
      node: [{ name: "homebase" }],
    });
    await c.services.report({ itemId: pc, source: "test", containers: [] });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(row.attributes?.containers).toBeUndefined();
    expect(JSON.parse(String(row.attributes?.node))).toEqual([{ name: "homebase" }]);
  });

  it("merges containers by name and leaves omitted keys", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({
      itemId: pc,
      source: "fleet",
      web: [{ label: "Workbench", url: "http://10.50.0.102:3002", port: 3002 }],
    });
    await c.services.report({
      itemId: pc,
      source: "local-docker",
      merge: true,
      containers: [{ name: "twin-homebase", status: "ok", image: "lidarventory:homebase", port: 8001 }],
    });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.web))).toEqual([
      expect.objectContaining({ label: "Workbench", port: 3002 }),
    ]);
    expect(JSON.parse(String(row.attributes?.containers))).toEqual([
      expect.objectContaining({ name: "twin-homebase", status: "ok", port: 8001 }),
    ]);
    await c.services.report({
      itemId: pc,
      source: "local-docker",
      merge: true,
      containers: [{ name: "apache-php", status: "ok", port: 80 }],
    });
    const [merged] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(merged.attributes?.containers)).map((x: { name: string }) => x.name).sort()).toEqual([
      "apache-php",
      "twin-homebase",
    ]);
    expect(JSON.parse(String(merged.attributes?.web))[0].label).toBe("Workbench");
  });

  it("stores guest IP and HTTP on Proxmox LXC", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({
      itemId: pc,
      source: "proxmox",
      lxc: [
        {
          vmid: 103,
          name: "guacamole",
          status: "running",
          ip: "10.50.0.40",
          url: "http://10.50.0.40:8080/guacamole",
          ports: [8080],
        },
      ],
      web: [{ label: "Proxmox", url: "https://10.50.0.155:8006", port: 8006 }],
    });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.lxc))).toEqual([
      expect.objectContaining({
        vmid: 103,
        name: "guacamole",
        ip: "10.50.0.40",
        url: "http://10.50.0.40:8080/guacamole",
        port: 8080,
      }),
    ]);
    expect(JSON.parse(String(row.attributes?.web))).toEqual([
      expect.objectContaining({ label: "Proxmox", port: 8006 }),
    ]);
  });

  it("writes proxmox vms and lxc without clearing containers", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({ itemId: pc, source: "test", containers: [{ name: "nginx" }] });
    await c.services.report({
      itemId: pc,
      source: "proxmox",
      vms: [{ vmid: 100, name: "win11", status: "stopped", memMb: 8192, diskGb: 64 }],
      lxc: [{ vmid: 102, name: "puppet", status: "running" }],
    });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.containers))).toEqual([{ name: "nginx" }]);
    expect(JSON.parse(String(row.attributes?.vms))).toEqual([
      expect.objectContaining({ vmid: 100, name: "win11", status: "stopped", memMb: 8192, diskGb: 64 }),
    ]);
    expect(JSON.parse(String(row.attributes?.lxc))).toEqual([expect.objectContaining({ vmid: 102, name: "puppet", status: "running" })]);
  });

  it("writes databases and projects without clearing containers", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({ itemId: pc, source: "test", containers: [{ name: "nginx" }] });
    const wrote = await c.services.report({
      itemId: pc,
      source: "fleet",
      databases: [{ name: "declutter", engine: "mysql", status: "ok" }],
      projects: [{ name: "declutter", kind: "claude", status: "active", tokens: 1_200_000, updatedAt: "2026-10-10" }],
    });
    expect(wrote).toEqual(expect.objectContaining({ databases: 1, projects: 1, containers: 0 }));
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.containers))).toEqual([{ name: "nginx" }]);
    expect(JSON.parse(String(row.attributes?.databases))).toEqual([
      expect.objectContaining({ name: "declutter", engine: "mysql", status: "ok" }),
    ]);
    expect(JSON.parse(String(row.attributes?.projects))).toEqual([
      expect.objectContaining({ name: "declutter", kind: "claude", status: "active", tokens: 1_200_000 }),
    ]);
  });

  it("merges fleet + projects rows on the same path and keeps the richer one", async () => {
    const { houseId, pc } = await seed();
    const c = callerFor(houseId);
    await c.services.report({
      itemId: pc,
      source: "fleet",
      merge: true,
      projects: [{ name: "declutter", path: "/Volumes/T7/declutter", kind: "unknown" }],
    });
    await c.services.report({
      itemId: pc,
      source: "projects",
      merge: true,
      projects: [{ name: "declutter", path: "/Volumes/T7/declutter", kind: "claude", tokens: 1_200_000, updatedAt: "2026-10-10" }],
    });
    const [row] = await getTestDb().select().from(items).where(eq(items.id, pc));
    expect(JSON.parse(String(row.attributes?.projects))).toEqual([
      expect.objectContaining({
        name: "declutter",
        path: "/Volumes/T7/declutter",
        kind: "claude",
        tokens: 1_200_000,
        updatedAt: "2026-10-10",
      }),
    ]);
  });

  it("refuses a non-machine or archived item", async () => {
    const { houseId, pc, chair } = await seed();
    const c = callerFor(houseId);
    await expect(c.services.report({ itemId: chair, source: "test", containers: [{ name: "x" }] })).rejects.toThrow(/not a machine/);
    await getTestDb().update(items).set({ status: "archived" }).where(eq(items.id, pc));
    await expect(c.services.report({ itemId: pc, source: "test", containers: [{ name: "x" }] })).rejects.toThrow(/archived/);
  });
});
