import { describe, expect, it } from "vitest";
import {
  matchPveMachine,
  parsePctList,
  parsePveConfigBlocks,
  parsePveGuestConfig,
  parsePveResources,
  parseQmList,
  parseProxmoxInventory,
  applyPveGuestConfig,
} from "../lib/servicesProxmox";

const pct = `VMID       Status     Lock         Name
102        running                 puppet
103        running                 guacamole
`;

const qm = `      VMID NAME                 STATUS     MEM(MB)    BOOT DISK(GB)
       100 win11                stopped    8192              64.00
       101 paperport-xp         stopped    2048              32.00
       104 sharedwin7           stopped    4096              40.00
       110 mp-werkplek          stopped    8192              80.00
       111 template-win11-werkplek stopped 8192              64.00
       113 template-win11-schoon stopped   8192              64.00
`;

describe("parse Proxmox lists", () => {
  it("reads pct list LXC", () => {
    expect(parsePctList(pct).map((g) => ({ vmid: g.vmid, name: g.name, status: g.status }))).toEqual([
      { vmid: 102, name: "puppet", status: "running" },
      { vmid: 103, name: "guacamole", status: "running" },
    ]);
  });

  it("reads qm list VMs and flags templates", () => {
    const vms = parseQmList(qm);
    expect(vms).toHaveLength(6);
    expect(vms.find((g) => g.vmid === 100)).toEqual(
      expect.objectContaining({ name: "win11", status: "stopped", memMb: 8192, diskGb: 64 }),
    );
    expect(vms.find((g) => g.vmid === 111)?.template).toBe(true);
    expect(vms.find((g) => g.vmid === 113)?.template).toBe(true);
  });

  it("prefers pvesh cluster resources JSON", () => {
    const { vms, lxc } = parsePveResources([
      { type: "qemu", vmid: 100, name: "win11", status: "stopped", maxmem: 8192 * 1024 * 1024, maxdisk: 64 * 1024 * 1024 * 1024 },
      { type: "qemu", vmid: 111, name: "template-win11-werkplek", status: "stopped", template: 1 },
      { type: "lxc", vmid: 102, name: "puppet", status: "running", maxmem: 512 * 1024 * 1024 },
      { type: "node", node: "pve" },
    ]);
    expect(lxc.map((g) => g.name)).toEqual(["puppet"]);
    expect(vms.map((g) => g.vmid)).toEqual([100, 111]);
    expect(vms.find((g) => g.vmid === 111)?.template).toBe(true);
    expect(vms.find((g) => g.vmid === 100)?.memMb).toBe(8192);
    expect(parsePveResources([{ type: "qemu", vmid: 113, name: "template-win11-schoon", status: "stopped", template: 1, maxdisk: 0 }]).vms[0].diskGb).toBeUndefined();
  });

  it("reads qemu disk keys and skips cdrom/none", () => {
    const vm = parsePveGuestConfig(
      `memory: 8192\nscsi0: local-zfs:vm-100-disk-0,size=64G\nide2: none,media=cdrom\nunused0: local-zfs:vm-100-disk-9\n`,
      "qemu",
    );
    expect(vm.memMb).toBe(8192);
    expect(vm.disks).toEqual([{ name: "scsi0", sizeGb: 64, storage: "local-zfs" }]);
    expect(vm.mounts).toBeUndefined();
  });

  it("reads LXC rootfs and mpN as mounts, not disks", () => {
    const lxc = parsePveGuestConfig(
      `memory: 512\nrootfs: local-zfs:vm-102-disk-0,size=8G\nmp0: /tank/share,mp=/mnt/share\n`,
      "lxc",
    );
    expect(lxc.disks).toBeUndefined();
    expect(lxc.mounts).toEqual([
      expect.objectContaining({ dest: "/", type: "rootfs", source: "local-zfs:vm-102-disk-0", size: 8e9 }),
      expect.objectContaining({ dest: "/mnt/share", type: "mp", source: "/tank/share" }),
    ]);
    const blocks = parsePveConfigBlocks(
      "=== 100 ===\nscsi0: local-zfs:vm-100-disk-0,size=64G\n=== 102 ===\nrootfs: local-zfs:subvol,size=8G\n",
    );
    expect(blocks.get(100)).toMatch(/scsi0/);
    const inv = parseProxmoxInventory({
      resourcesJson: [{ type: "qemu", vmid: 100, name: "win11", status: "stopped", maxmem: 1024 }],
      qmConfigs: "=== 100 ===\nmemory: 8192\nscsi0: local-zfs:vm-100-disk-0,size=64G\n",
    });
    expect(inv.vms[0].diskGb).toBe(64);
    expect(inv.vms[0].memMb).toBe(8192);
    const lxcInv = parseProxmoxInventory({
      resourcesJson: [{ type: "lxc", vmid: 103, name: "guacamole", status: "running", node: "pve" }],
      pctConfigs: "=== 103 ===\nmemory: 512\nrootfs: local-lvm:vm-103-disk-0,size=8G\n",
    });
    expect(lxcInv.lxc[0].diskGb).toBe(8);
    expect(lxcInv.lxc[0].disks).toBeUndefined();
    expect(lxcInv.lxc[0].mounts?.[0]).toEqual(expect.objectContaining({ type: "rootfs", dest: "/" }));
  });

  it("parses pve guest disks and LXC rootfs from pvesh JSON", () => {
    const vm100 = parsePveGuestConfig(
      {
        memory: 8192,
        sata0: "local-zfs:vm-100-disk-0,size=130G",
        sata1: "local-zfs:vm-100-disk-1,size=120G",
        efidisk0: "local-zfs:vm-100-disk-2,efitype=4m,pre-enrolled-keys=1,size=4M",
        tpmstate0: "local-zfs:vm-100-disk-3,size=4M,version=v2.0",
        ide2: "none,media=cdrom",
      },
      "qemu",
    );
    expect(vm100.disks).toEqual([
      { name: "sata0", sizeGb: 130, storage: "local-zfs" },
      { name: "sata1", sizeGb: 120, storage: "local-zfs" },
      { name: "efidisk0", sizeGb: 0.0039, storage: "local-zfs" },
      { name: "tpmstate0", sizeGb: 0.0039, storage: "local-zfs" },
    ]);
    const vm101 = parsePveGuestConfig({ ide0: "local-zfs:vm-101-disk-0,size=20G", ide1: "local-zfs:vm-101-disk-1,size=4G" }, "qemu");
    expect(vm101.disks).toEqual([
      { name: "ide0", sizeGb: 20, storage: "local-zfs" },
      { name: "ide1", sizeGb: 4, storage: "local-zfs" },
    ]);
    const vm104 = parsePveGuestConfig({ ide0: "local-backup:vm-104-disk-0,size=466G" }, "qemu");
    expect(vm104.disks).toEqual([{ name: "ide0", sizeGb: 466, storage: "local-backup" }]);
    for (const vmid of [110, 111, 113]) {
      const cfg = parsePveGuestConfig({ sata0: `local-zfs:vm-${vmid}-disk-0,size=60G` }, "qemu");
      expect(cfg.disks).toEqual([{ name: "sata0", sizeGb: 60, storage: "local-zfs" }]);
    }
    const lxc102 = applyPveGuestConfig(
      { vmid: 102, name: "puppet", status: "running", node: "pve" },
      { data: { memory: 512, rootfs: "local-lvm:vm-102-disk-0,size=5G" } },
      "lxc",
    );
    expect(lxc102.diskGb).toBe(5);
    expect(lxc102.disks).toBeUndefined();
    expect(lxc102.mounts).toEqual([expect.objectContaining({ dest: "/", type: "rootfs", size: 5e9 })]);
    const lxc103 = applyPveGuestConfig(
      { vmid: 103, name: "guacamole", status: "running" },
      { rootfs: "local-lvm:vm-103-disk-0,size=8G" },
      "lxc",
    );
    expect(lxc103.diskGb).toBe(8);
    const enriched = applyPveGuestConfig(
      { vmid: 100, name: "win11", status: "stopped", diskGb: 64, node: "pve" },
      { sata0: "local-zfs:vm-100-disk-0,size=130G", sata1: "local-zfs:vm-100-disk-1,size=120G", efidisk0: "local-zfs:x,size=4M" },
      "qemu",
    );
    expect(enriched.diskGb).toBe(250);
    expect(enriched.disks?.map((d) => d.name)).toEqual(["sata0", "sata1", "efidisk0"]);
  });

  it("falls back to pct/qm when pvesh is empty", () => {
    const inv = parseProxmoxInventory({ resourcesJson: [], pctList: pct, qmList: qm });
    expect(inv.lxc).toHaveLength(2);
    expect(inv.vms).toHaveLength(6);
  });
});

describe("matchPveMachine", () => {
  const machines = [
    { id: 51, name: "Mac mini", hostname: "macmini-m4", ip: "10.50.0.102" },
    { id: 80, name: "Proxmox box", hostname: "pve", ip: "10.50.0.155" },
    { id: 201, name: "dockermac-1", hostname: "dockermac-1", ip: "10.50.0.10" },
  ];

  it("matches hostname pve, then IP, then name containing proxmox", () => {
    expect(matchPveMachine(machines)?.id).toBe(80);
    expect(matchPveMachine(machines.filter((m) => m.id !== 80))?.id).toBeUndefined();
    expect(
      matchPveMachine([
        { id: 9, name: "something", ip: "10.50.0.155" },
        { id: 8, name: "Proxmox host" },
      ])?.id,
    ).toBe(9);
    expect(matchPveMachine([{ id: 8, name: "Proxmox host" }])?.id).toBe(8);
  });
});
