import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, events, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import {
  attributePatch,
  matchKey,
  parseRegisterMachines,
  planRegisterImport,
  preferredIp,
  type MachineItem,
} from "../lib/registerMachines";
import { IP_REFRESHED_AT } from "../lib/ipRefresh";

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/register-machines.json"), "utf8"));
const machines = parseRegisterMachines(fixture);
const byName = (c: string) => machines.find((m) => m.canonical === c)!;

const thing = (id: number, name: string, attributes: Record<string, string | number>, status = "active"): MachineItem => ({
  id,
  name,
  status,
  attributes: { role: "desktop", ...attributes },
});

describe("parseRegisterMachines", () => {
  it("reads serial, model, cards and names; rejects another shape", () => {
    expect(machines.map((m) => m.canonical).sort()).toEqual(["TavServ", "dockermac", "iMac-Clawd", "imac27-ben", "macmini-m4", "mba-m4", "pi-zigbee"]);
    const mini = byName("macmini-m4");
    expect(mini).toMatchObject({ serial: "J5T940JGFV", model: "Mac16,10", liveIps: ["10.50.0.102"], aliases: ["mm4", "mini", "macmini-m4 — wifi", "macmini-m4 — LAN"] });
    expect(mini.devices.map((d) => `${d.ip}@${d.mac}`)).toEqual(["10.50.0.102@7a:42:cb:64:af:90", "10.50.0.102@1c:f6:4c:53:96:71", "10.50.0.247@1c:f6:4c:58:32:e8"]);
    expect(byName("iMac-Clawd").lifecycle).toBe("weg");
    expect(preferredIp(byName("imac27-ben"))).toBe("10.50.0.236");
    expect(preferredIp(byName("TavServ"))).toBe("10.50.0.115");
    expect(() => parseRegisterMachines({ hosts: [] })).toThrow(/machines/);
  });
});

describe("matchKey", () => {
  it("prefers serial, then machine.id, then a card's MAC, then hostname and IP", () => {
    const mini = byName("macmini-m4");
    expect(matchKey(thing(1, "a", { serial: "j5t940jgfv", hostname: "other" }), mini)).toBe("serial");
    expect(matchKey(thing(1, "a", { "machine.id": "mm4" }), mini)).toBe("machine.id");
    expect(matchKey(thing(1, "a", { hostname: "MACMINI-M4.local" }), mini)).toBe("hostname");
    expect(matchKey(thing(1, "a", { ip: "10.50.0.247" }), mini)).toBe("ip");
    expect(matchKey(thing(1, "a", { mac: "1C:F6:4C:58:32:E8" }), mini)).toBe("mac");
    expect(matchKey(thing(1, "a", { hostname: "mini", macs: "aa:bb:cc:dd:ee:ff,1c:f6:4c:53:96:71" }), mini)).toBe("mac");
    expect(matchKey(thing(1, "a", { hostname: "zigbee2mqtt" }), byName("pi-zigbee"))).toBe("hostname");
    expect(matchKey(thing(1, "a", { hostname: "nope", ip: "10.50.0.1" }), mini)).toBeNull();
  });
});

describe("attributePatch", () => {
  it("fills what is empty, refreshes the IP, merges aliases without the hostname or IPs, and flags disagreements", () => {
    const { set, conflicts } = attributePatch(
      thing(51, "Mac mini", { hostname: "macmini-m4", "machine.id": "macmini-m4", ip: "10.50.0.102", model: "" }),
      byName("macmini-m4"),
    );
    expect(conflicts).toEqual([]);
    expect(set).toEqual({
      serial: "J5T940JGFV",
      uuid: "514b5ba0-7158-53db-9f16-9aae09cb2e03",
      model: "Mac16,10",
      aliases: "mm4,mini,macmini-m4 — wifi,macmini-m4 — lan",
      mac: "7a:42:cb:64:af:90",
      macs: "7a:42:cb:64:af:90,1c:f6:4c:53:96:71,1c:f6:4c:58:32:e8",
    });
    const ben = attributePatch(
      thing(182, "iMac", { hostname: "iMac-Clawd", ip: "10.50.0.158", mac: "EC:35:86:41:08:22", model: "iMac 27" }),
      byName("imac27-ben"),
    );
    expect(ben.set).toMatchObject({ serial: "C02KGM1LDNCV", "machine.id": "imac27-ben", ip: "10.50.0.236" });
    expect(ben.set.model).toBeUndefined();
    expect(ben.set.mac).toBeUndefined();
    expect(ben.set.aliases).toContain("imac27-ben");
    expect(ben.set.aliases).not.toContain("10.50.0.");
    const clash = attributePatch(thing(5, "x", { "machine.id": "mm4", serial: "OTHER123" }), byName("macmini-m4"));
    expect(clash.conflicts).toEqual([{ key: "serial", have: "OTHER123", want: "J5T940JGFV" }]);
    const wrongId = attributePatch(thing(5, "x", { serial: "J5T940JGFV", "machine.id": "someone-else" }), byName("macmini-m4"));
    expect(wrongId.conflicts).toEqual([{ key: "machine.id", have: "someone-else", want: "macmini-m4" }]);
  });
});

describe("planRegisterImport", () => {
  const things = [
    thing(51, "Apple Mac mini M4", { hostname: "macmini-m4", "machine.id": "macmini-m4", ip: "10.50.0.102" }),
    thing(12, "MacBook Air M4", { role: "laptop", hostname: "mba-m4", ip: "10.50.0.106", model: "MacBook Air M4" }),
    thing(212, "rpi-zigbee2mqtt", { role: "sbc", hostname: "zigbee2mqtt", ip: "10.50.0.105" }),
    thing(182, "Apple iMac (second unit)", { hostname: "iMac-Clawd", ip: "10.50.0.158", mac: "EC:35:86:41:08:22" }),
    thing(204, "synology-nas", { role: "nas", hostname: "TavServ", "machine.id": "TavServ", ip: "10.50.0.115" }),
    thing(206, "imac-27-2010", {}),
    thing(99, "a lamp", { role: "lamp", hostname: "dockermac" }),
    thing(100, "archived twin", { hostname: "dockermac" }, "archived"),
  ];

  it("matches strong (serial, machine.id, MAC) before weak, never a written-off machine, and lists the leftovers", () => {
    const plan = planRegisterImport(things, machines);
    const row = (c: string) => plan.rows.find((r) => r.machine.canonical === c)!;
    expect(row("macmini-m4")).toMatchObject({ itemId: 51, matchedBy: "machine.id", strong: true, skipped: null });
    expect(row("mba-m4")).toMatchObject({ itemId: 12, matchedBy: "hostname", strong: false });
    expect(row("mba-m4").set).toMatchObject({ "machine.id": "mba-m4", serial: "KTXGGVWFM4" });
    expect(row("pi-zigbee")).toMatchObject({ itemId: 212, matchedBy: "hostname", strong: false });
    // hostname says iMac-Clawd (written off), the MAC says imac27-ben: hardware wins, and strongly
    expect(row("imac27-ben")).toMatchObject({ itemId: 182, matchedBy: "mac", strong: true });
    expect(row("iMac-Clawd")).toMatchObject({ itemId: null, skipped: "lifecycle weg" });
    expect(row("TavServ")).toMatchObject({ itemId: 204, matchedBy: "machine.id", strong: true });
    // the lamp and the archived twin are not machines; dockermac has no Thing here
    expect(row("dockermac")).toMatchObject({ itemId: null, skipped: "no Thing matches" });
    expect(plan.unmatchedItems).toEqual([{ id: 206, name: "imac-27-2010" }]);
    expect(plan.counts).toEqual({ machines: 7, matched: 5, strong: 3, weak: 2, conflicts: 0, noThing: 2, unmatchedItems: 1 });
  });

  it("does not let a weak hostname hit take a Thing whose serial names another machine, and reports an ambiguous key", () => {
    const plan = planRegisterImport(
      [
        thing(1, "the mini", { serial: "J5T940JGFV", hostname: "mba-m4" }),
        thing(2, "the air", { hostname: "air-m4" }),
        thing(3, "twin a", { aliases: "z2m-pi" }),
        thing(4, "twin b", { aliases: "z2m-pi", hostname: "z2m-pi" }),
      ],
      machines,
    );
    const row = (c: string) => plan.rows.find((r) => r.machine.canonical === c)!;
    expect(row("macmini-m4")).toMatchObject({ itemId: 1, matchedBy: "serial" });
    expect(row("mba-m4")).toMatchObject({ itemId: 2, matchedBy: "hostname" });
    expect(row("pi-zigbee").itemId).toBe(4);
    expect(row("pi-zigbee").matchedBy).toBe("hostname");
  });
});

describe("machines.importRegister", () => {
  let areaId: number;
  let h1: number;
  beforeEach(async () => {
    await resetTestDb();
    const db = getTestDb();
    [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    [{ id: areaId }] = await db.insert(areas).values({ slug: "computers", name: "Computers" }).$returningId();
  });

  it("is dry by default, writes strong rows on apply, weak only with acceptWeak, and logs one event per Thing", async () => {
    const db = getTestDb();
    const [{ id: mini }] = await db
      .insert(items)
      .values({ areaId, houseId: h1, name: "Mac mini", attributes: { role: "desktop", "machine.id": "macmini-m4", hostname: "macmini-m4", ip: "10.50.0.102" } })
      .$returningId();
    const [{ id: air }] = await db
      .insert(items)
      .values({ areaId, houseId: h1, name: "Air", attributes: { role: "laptop", hostname: "mba-m4", ip: "10.50.0.1" } })
      .$returningId();
    const caller = callerFor(h1);

    const dry = await caller.machines.importRegister({ machines: fixture });
    expect(dry.dry).toBe(true);
    expect(dry.applied).toEqual([]);
    expect((await db.query.items.findFirst({ where: eq(items.id, mini) }))?.attributes).not.toHaveProperty("serial");

    const strong = await caller.machines.importRegister({ machines: fixture, dry: false });
    expect(strong.applied.map((a) => a.itemId)).toEqual([mini]);
    const miniAfter = (await db.query.items.findFirst({ where: eq(items.id, mini) }))!.attributes!;
    expect(miniAfter).toMatchObject({ serial: "J5T940JGFV", model: "Mac16,10", mac: "7a:42:cb:64:af:90", ip: "10.50.0.102" });
    expect((await db.query.items.findFirst({ where: eq(items.id, air) }))?.attributes).not.toHaveProperty("serial");

    const weak = await caller.machines.importRegister({ machines: fixture, dry: false, acceptWeak: true });
    expect(weak.applied.map((a) => a.itemId)).toEqual([air]);
    const airAfter = (await db.query.items.findFirst({ where: eq(items.id, air) }))!.attributes!;
    expect(airAfter).toMatchObject({ serial: "KTXGGVWFM4", "machine.id": "mba-m4", ip: "10.50.0.106" });
    expect(airAfter[IP_REFRESHED_AT]).toBeTruthy();

    const logged = await db.select().from(events).where(eq(events.entityId, air));
    expect(logged.filter((e) => e.action === "updated" && e.actor === "system")).toHaveLength(1);
    await expect(caller.machines.importRegister({ machines: { nope: 1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
