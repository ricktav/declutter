import { describe, expect, it } from "vitest";
import {
  isThisMachine,
  parseDfTable,
  parseMeasureTsv,
  pickSshHost,
  planStarredDirReports,
  skipMount,
  starredMachinesFromItems,
  type StarredMachine,
} from "../lib/storageMeasure";

function machine(partial: Partial<StarredMachine> & { id: number; name: string }): StarredMachine {
  const hostname = partial.hostname ?? null;
  const ip = partial.ip ?? null;
  const machineId = partial.machineId ?? null;
  const aliases = partial.aliases ?? null;
  const identityOptions = partial.identityOptions ?? ([machineId, hostname, ip, aliases].filter(Boolean) as string[]);
  return { hostname, ip, machineId, aliases, identityOptions, ...partial };
}

describe("skipMount", () => {
  it("keeps boot, Data and ordinary mounts, drops APFS internals and snapshots", () => {
    expect(skipMount("/")).toBe(false);
    expect(skipMount("/System/Volumes/Data")).toBe(false);
    expect(skipMount("/Volumes/T7")).toBe(false);
    expect(skipMount("/System/Volumes/Preboot")).toBe(true);
    expect(skipMount("/System/Volumes/VM")).toBe(true);
    expect(skipMount("/private/var/vm")).toBe(true);
    expect(skipMount("/Users/x/Library/Developer/CoreSimulator/foo")).toBe(true);
    expect(skipMount("/Volumes/.timemachine/xyz")).toBe(true);
    expect(skipMount("/proc")).toBe(true);
  });
});

describe("starredMachinesFromItems", () => {
  it("keeps starred computers and NAS, not disks or unstarred boxes", () => {
    const rows = starredMachinesFromItems([
      { id: 51, name: "Mac mini M4", attributes: { role: "desktop", hostname: "macmini-m4", "storage.starred": "yes" } },
      { id: 40, name: "synology", attributes: { role: "nas", hostname: "TavServ", ip: "10.50.0.20", "storage.starred": "yes" } },
      { id: 9, name: "Mac", attributes: { role: "laptop", hostname: "Mac" } },
      { id: 243, name: "Samsung T7 2TB", attributes: { role: "storage", "storage.starred": "yes" } },
      { id: 1, name: "chair", attributes: { role: "furniture", "storage.starred": "yes" } },
    ]);
    expect(rows.map((r) => r.id)).toEqual([51, 40]);
  });
});

describe("pickSshHost and this-machine", () => {
  it("prefers IP over hostname and never SSHes a MAC", () => {
    expect(pickSshHost(machine({ id: 1, name: "opti", hostname: "optiplex-990", ip: "10.50.0.88" }))).toBe("10.50.0.88");
    expect(pickSshHost(machine({ id: 2, name: "mini", hostname: "macmini-m4.local" }))).toBe("macmini-m4");
    expect(pickSshHost(machine({ id: 3, name: "ghost", machineId: "aa:bb:cc:dd:ee:ff", identityOptions: ["aa:bb:cc:dd:ee:ff"] }))).toBeNull();
  });

  it("treats this host as local by hostname or LAN IP", () => {
    const mini = machine({ id: 51, name: "Mac mini M4", hostname: "macmini-m4", ip: "10.50.0.102" });
    expect(isThisMachine(mini, { hostname: "macmini-m4.local", ips: ["10.50.0.102"] })).toBe(true);
    expect(isThisMachine(mini, { hostname: "dockermac-1", ips: ["10.50.0.50"] })).toBe(false);
    expect(isThisMachine(mini, { hostname: "other", ips: ["10.50.0.102"] })).toBe(true);
  });
});

describe("planStarredDirReports", () => {
  it("runs this host locally, SSHes the rest, skips a box with no address", () => {
    const plan = planStarredDirReports(
      [
        machine({ id: 51, name: "Mac mini M4", hostname: "macmini-m4", ip: "10.50.0.102" }),
        machine({ id: 203, name: "OptiPlex 990", hostname: "optiplex-990", ip: "10.50.0.88" }),
        machine({ id: 9, name: "Dead laptop", hostname: null, ip: null, identityOptions: [] }),
      ],
      { hostname: "macmini-m4", ips: ["10.50.0.102"] },
      { sshUser: "ricktav" },
    );
    expect(plan).toEqual([
      { itemId: 51, name: "Mac mini M4", via: "local" },
      { itemId: 203, name: "OptiPlex 990", via: "ssh", sshUser: "ricktav", sshHost: "10.50.0.88" },
      { itemId: 9, name: "Dead laptop", via: "skip", reason: "no hostname or IP to SSH" },
    ]);
  });

  it("restricts to one item id", () => {
    const plan = planStarredDirReports(
      [
        machine({ id: 51, name: "Mac mini M4", hostname: "macmini-m4", ip: "10.50.0.102" }),
        machine({ id: 203, name: "OptiPlex 990", hostname: "optiplex-990", ip: "10.50.0.88" }),
      ],
      { hostname: "macmini-m4", ips: ["10.50.0.102"] },
      { itemId: 203, sshUser: "ricktav" },
    );
    expect(plan).toEqual([{ itemId: 203, name: "OptiPlex 990", via: "ssh", sshUser: "ricktav", sshHost: "10.50.0.88" }]);
  });
});

const darwinDf = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   971350180  16000000  20000000    45%    /
/dev/disk3s5     971350180  80000000  20000000    80%    /System/Volumes/Data
/dev/disk3s6     971350180     50000  20000000     1%    /System/Volumes/Preboot
/dev/disk7s1    1953514584 100000000 1800000000    6%    /Volumes/T7
map auto_home            0         0         0   100%    /System/Volumes/Data/home
`;

const linuxDf = `Filesystem     Type     1024-blocks      Used Available Capacity Mounted on
/dev/sda2      ext4        236000000 113000000 110000000      51% /
tmpfs          tmpfs        16000000         0  16000000       0% /run
/dev/sde1      fuseblk   11721052160 3840000000 7881052160    33% /media/rick/Elements
/dev/loop0     squashfs        64000     64000         0     100% /snap/core/1
//nas/share     nfs        1000000000  400000000 600000000     40% /mnt/backup
`;

describe("parseDfTable", () => {
  it("reads macOS df, keeps Data, drops Preboot", () => {
    const rows = parseDfTable(darwinDf, true);
    expect(rows.map((r) => [r.mountPoint, r.device, r.container])).toEqual([
      ["/", "disk3s1s1", "disk3"],
      ["/System/Volumes/Data", "disk3s5", "disk3"],
      ["/Volumes/T7", "disk7s1", "disk7"],
    ]);
    expect(rows[0].capacityBytes).toBe(971350180 * 1024);
    expect(rows[0].usedBytes).toBe(16000000 * 1024);
  });

  it("reads Linux df, drops tmpfs/loop/nfs, keeps USB fuseblk, uses blocks-avail", () => {
    const rows = parseDfTable(linuxDf, false);
    expect(rows.map((r) => r.mountPoint)).toEqual(["/", "/media/rick/Elements"]);
    expect(rows[0].fsType).toBe("ext4");
    expect(rows[0].container).toBeNull();
    expect(rows[0].usedBytes).toBe((236000000 - 110000000) * 1024);
  });
});

describe("parseMeasureTsv", () => {
  it("attaches dirs, drops / dirs when Data is present, caps top N", () => {
    const tsv = [
      "measuring /System/Volumes/Data …",
      "VOL\t/\tdisk3s1s1\tapfs\tdisk3\t994000000000\t16000000000",
      "DIR\t/\t/Users\t500000000000",
      "VOL\t/System/Volumes/Data\tdisk3s5\tapfs\tdisk3\t994000000000\t800000000000",
      "DIR\t/System/Volumes/Data\t/Users\t500000000000",
      "DIR\t/System/Volumes/Data\t/Applications\t40000000000",
      "DIR\t/System/Volumes/Data\t/Library\t30000000000",
      "VOL\t/Volumes/T7\tdisk7s1\tapfs\tdisk7\t2000000000000\t310000000000",
      "DIR\t/Volumes/T7\t/Volumes/T7/declutter\t120000000000",
    ].join("\n");
    const vols = parseMeasureTsv(tsv, 2);
    expect(vols.map((v) => v.mountPoint)).toEqual(["/", "/System/Volumes/Data", "/Volumes/T7"]);
    expect(vols[0].dirs).toEqual([]);
    expect(vols[1].dirs).toEqual([
      { path: "/Users", bytes: 500000000000 },
      { path: "/Applications", bytes: 40000000000 },
    ]);
    expect(vols[1].label).toBe("Data");
    expect(vols[2].label).toBe("T7");
    expect(vols[2].dirs).toEqual([{ path: "/Volumes/T7/declutter", bytes: 120000000000 }]);
  });

  it("clears a container whose volumes disagree on capacity", () => {
    const tsv = [
      "VOL\t/\tsda1\text4\tsda\t256000000000\t80000000000",
      "VOL\t/boot\tsda2\text4\tsda\t1000000000\t200000000",
    ].join("\n");
    const vols = parseMeasureTsv(tsv);
    expect(vols.map((v) => v.container)).toEqual([null, null]);
  });
});
