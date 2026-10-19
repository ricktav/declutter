import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  derivedType,
  isMachineItem,
  isUnder,
  judgeComputer,
  matchesTaxonomy,
  SCHEMA_PRESETS,
  tagsOf,
  TYPE_LABELS,
  TYPE_TREE,
} from "@db/taxonomy";
import * as systemsAttrs from "@/lib/systemsAttrs";

describe("type tree", () => {
  it("every parent is a node and every node has a label", () => {
    for (const [t, p] of Object.entries(TYPE_TREE)) {
      if (p != null) expect(TYPE_TREE).toHaveProperty(p);
      expect(TYPE_LABELS[t]).toBeTruthy();
    }
    expect(TYPE_LABELS["mac-mini"]).toBe("Mac mini");
    expect(TYPE_LABELS["raspberry-pi"]).toBe("Raspberry Pi");
  });

  it("ancestors of imac are desktop, computer", () => {
    expect(ancestorsOf("imac")).toEqual(["desktop", "computer"]);
    expect(ancestorsOf("computer")).toEqual([]);
    expect(ancestorsOf("unknown")).toEqual([]);
  });

  it("a NAS is under computer; subtree test includes the node itself", () => {
    expect(isUnder("nas", "computer")).toBe(true);
    expect(isUnder("computer", "computer")).toBe(true);
    expect(isUnder("monitor", "computer")).toBe(false);
    expect(isUnder(null, "computer")).toBe(false);
  });

  it("presets resolve to subtrees", () => {
    const computers = SCHEMA_PRESETS.find((p) => p.id === "computers")!;
    const cds = SCHEMA_PRESETS.find((p) => p.id === "computers-displays-storage")!;
    const under = (types: string[]) => Object.keys(TYPE_TREE).filter((t) => types.some((n) => isUnder(t, n))).sort();
    expect(under(computers.types)).toEqual(
      ["computer", "desktop", "imac", "laptop", "mac-mini", "macbook", "nas", "raspberry-pi", "sbc", "server", "tower"].sort(),
    );
    expect(under(cds.types)).toEqual(expect.arrayContaining(["imac", "nas", "monitor", "tv", "drive", "storage"]));
    expect(under(cds.types)).not.toContain("keyboard");
  });
});

describe("derivedType and tagsOf", () => {
  it("uses attributes.type first, else maps role", () => {
    expect(derivedType({ type: "iMac", role: "desktop" })).toBe("imac");
    expect(derivedType({ role: "nas" })).toBe("nas");
    expect(derivedType({ role: "Patch Panel" })).toBe("patch-panel");
    expect(derivedType({ role: "router" })).toBe("network");
    expect(derivedType({ role: "meter" })).toBe("meter");
    expect(derivedType({ role: "phone" })).toBe("phone");
    expect(derivedType({})).toBeNull();
    expect(derivedType({ role: "lamp" })).toBeNull();
    expect(derivedType({ type: "toaster", role: "desktop" })).toBe("desktop");
    expect(derivedType({ type: "toaster" })).toBe("toaster");
  });

  it("splits tags, adds brand, lower case, de-duplicated", () => {
    expect(tagsOf({ tags: "Apple, home lab,,apple", brand: "Apple" })).toEqual(["apple", "home-lab"]);
    expect(tagsOf({ brand: "Raspberry Pi" })).toEqual(["raspberry-pi"]);
    expect(tagsOf({})).toEqual([]);
  });
});

describe("filter semantics (Review Focus 7)", () => {
  const things: Array<[string, Record<string, unknown>]> = [
    ["imac", { type: "imac", brand: "Apple" }],
    ["mini", { type: "mac-mini", tags: "apple" }],
    ["pi", { type: "raspberry-pi", tags: "raspberry-pi" }],
    ["nas", { role: "nas", brand: "Synology" }],
    ["dell", { role: "laptop", brand: "Dell" }],
    ["keyboard", { role: "keyboard", brand: "Apple" }],
    ["monitor", { role: "monitor", brand: "Dell" }],
  ];
  const pick = (filter: { types?: string[]; tags?: string[] }) =>
    things.filter(([, a]) => matchesTaxonomy(a, filter)).map(([n]) => n);

  it("Type = subtree, a Thing without type derives it from role", () => {
    expect(pick({ types: ["computer"] })).toEqual(["imac", "mini", "pi", "nas", "dell"]);
  });
  it("Tags OR within the facet", () => {
    expect(pick({ tags: ["apple", "synology"] })).toEqual(["imac", "mini", "nas", "keyboard"]);
  });
  it("AND across facets", () => {
    expect(pick({ types: ["computer"], tags: ["dell"] })).toEqual(["dell"]);
    expect(pick({ types: ["computer", "display"], tags: ["dell", "apple"] })).toEqual(["imac", "mini", "dell", "monitor"]);
  });
  it("the Computers & storage preset hides a keyboard", () => {
    const cds = SCHEMA_PRESETS.find((p) => p.id === "computers-displays-storage")!;
    expect(pick({ types: cds.types })).not.toContain("keyboard");
  });
  it("empty facets match everything", () => {
    expect(pick({})).toHaveLength(things.length);
  });
});

describe("judgeComputer (Review Focus 6)", () => {
  it("a meter named 'Plugwise – Pi' is never a computer", () => {
    const v = judgeComputer({ name: "Plugwise – Pi", attributes: { role: "meter", meter_kind: "plug", mac: "000D6F0001" } });
    expect(v.verdict).toBe("no");
    expect(v.rule).toBe("veto");
  });

  it("'laptop power adapter' without ip/hostname/mac is never a computer", () => {
    const v = judgeComputer({ name: "laptop power adapter", attributes: {} });
    expect(v).toEqual({ verdict: "no", rule: "accessory" });
  });

  it("a Thing with an ip and no role is a computer", () => {
    const v = judgeComputer({ name: "Box in the attic", attributes: { ip: "10.50.0.12" } });
    expect(v.verdict).toBe("computer");
    expect(v.rule).toBe("machine-signal");
    expect(v.type).toBe("computer");
  });

  it("a NAS is a computer", () => {
    const v = judgeComputer({ name: "Synology DS920+", attributes: { role: "nas", brand: "Synology" } });
    expect(v).toMatchObject({ verdict: "computer", rule: "role", type: "nas" });
    expect(isUnder(v.type!, "computer")).toBe(true);
  });

  it("'Volumio PI' without role is suggested", () => {
    const v = judgeComputer({ name: "Volumio PI", attributes: {} });
    expect(v).toMatchObject({ verdict: "suggested", rule: "name", type: "raspberry-pi" });
    expect(v.tags).toContain("raspberry-pi");
  });

  it("a machine role picks a more specific Type and tags from the name", () => {
    expect(judgeComputer({ name: "iMac 27\"", attributes: { role: "desktop" } })).toMatchObject({
      verdict: "computer", type: "imac", tags: ["apple"],
    });
    expect(judgeComputer({ name: "Mac mini M4", attributes: { role: "desktop" } }).type).toBe("mac-mini");
    expect(judgeComputer({ name: "MacBook Pro", attributes: { role: "laptop" } }).type).toBe("macbook");
    expect(judgeComputer({ name: "Raspberry Pi 4", attributes: { role: "sbc" } }).type).toBe("raspberry-pi");
    // the name's Type is not under the role: keep the role
    expect(judgeComputer({ name: "Mac mini", attributes: { role: "server" } }).type).toBe("server");
    expect(judgeComputer({ name: "HP EliteDesk", attributes: { role: "desktop", brand: "HP" } }).tags).toEqual(["hp"]);
  });

  it("a non-computer role with an ip is never a computer; a storage volume counts as evidence", () => {
    expect(judgeComputer({ name: "Netgear GS108", attributes: { role: "switch", ip: "10.50.0.2" } }).verdict).toBe("no");
    expect(judgeComputer({ name: "Thing", attributes: {}, hasVolumes: true }).verdict).toBe("computer");
  });

  it("an unknown role with machine evidence is only suggested", () => {
    expect(judgeComputer({ name: "Printer", attributes: { role: "printer", ip: "10.50.0.40" } })).toMatchObject({
      verdict: "suggested", rule: "machine-signal",
    });
  });

  it("names that match nothing are 'none'; 'api' and 'pink' are not 'pi'", () => {
    expect(judgeComputer({ name: "Kettle", attributes: {} })).toEqual({ verdict: "no", rule: "none" });
    expect(judgeComputer({ name: "Pink api lamp", attributes: {} }).rule).toBe("none");
    expect(judgeComputer({ name: "Laptop stand", attributes: {} }).rule).toBe("accessory");
    expect(judgeComputer({ name: "Raspberry Pi case", attributes: {} }).rule).toBe("accessory");
  });

  it("agrees with isMachineItem on the 'computer' verdict", () => {
    const cases: Array<Record<string, string | number>> = [
      { role: "nas" }, { ip: "1.2.3.4" }, { role: "meter", ip: "1.2.3.4" }, { role: "keyboard" }, {}, { role: "printer", ip: "1.2.3.4" },
    ];
    for (const attributes of cases) {
      expect(judgeComputer({ name: "x", attributes }).verdict === "computer").toBe(isMachineItem({ attributes }));
    }
  });
});

describe("systemsAttrs re-exports the shared machine rule", () => {
  it("same functions, same exclusions", () => {
    expect(systemsAttrs.isMachineItem).toBe(isMachineItem);
    expect(systemsAttrs.MACHINE_ROLES.has("nas")).toBe(true);
    const base = { attributes: { role: "desktop" } };
    expect(isMachineItem(base)).toBe(true);
    expect(isMachineItem({ ...base, status: "archived" })).toBe(false);
    expect(isMachineItem({ attributes: { role: "desktop", "lab.exclude": "yes" } })).toBe(false);
    expect(isMachineItem({ ...base, parentId: 3 })).toBe(false);
  });
});
