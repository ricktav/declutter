import { describe, expect, it } from "vitest";
import { matchPveMachine, parsePctList, parsePveResources, parseQmList, parseProxmoxInventory } from "../lib/servicesProxmox";

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
