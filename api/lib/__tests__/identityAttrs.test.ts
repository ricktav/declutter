import { describe, expect, it } from "vitest";
import { commonIpv4Prefix, identityEntries, identityKind, normalizeIdentityValue } from "../identityAttrs";

describe("identityKind", () => {
  it("maps the key variants used in the data", () => {
    expect(identityKind("serial")).toBe("serial");
    expect(identityKind("Serial_Number")).toBe("serial");
    expect(identityKind("mac_address")).toBe("mac");
    expect(identityKind("IP")).toBe("ip");
    expect(identityKind("ip_address")).toBe("ip");
    expect(identityKind("hostname")).toBe("hostname");
    expect(identityKind("host")).toBe("hostname");
    expect(identityKind("role")).toBeNull();
  });
});

describe("normalizeIdentityValue", () => {
  it("trims and folds case", () => {
    expect(normalizeIdentityValue("serial", "  C02X  ")).toBe("c02x");
    expect(normalizeIdentityValue("hostname", "Nas-1.Local")).toBe("nas-1.local");
    expect(normalizeIdentityValue("ip", " 192.168.1.1 ")).toBe("192.168.1.1");
  });
  it("strips MAC separators", () => {
    expect(normalizeIdentityValue("mac", "AA:BB:CC:DD:EE:FF")).toBe("aabbccddeeff");
    expect(normalizeIdentityValue("mac", "aa-bb.cc.dd-ee-ff")).toBe("aabbccddeeff");
  });
  it("treats blank as empty", () => {
    expect(normalizeIdentityValue("serial", "   ")).toBe("");
  });
});

describe("identityEntries", () => {
  it("keeps only identity keys with a normalized value", () => {
    expect(identityEntries({ role: "laptop", serial: " C02X ", mac: "" })).toEqual([
      { kind: "serial", key: "serial", value: " C02X ", normalized: "c02x" },
    ]);
  });
});

describe("commonIpv4Prefix", () => {
  it("returns the most frequent first three octets with a trailing dot", () => {
    expect(
      commonIpv4Prefix(["10.50.0.10", "10.50.0.11", "192.168.1.1", "10.50.0.12", "not-an-ip"]),
    ).toBe("10.50.0.");
  });
  it("returns null when no IPv4 values exist", () => {
    expect(commonIpv4Prefix(["fe80::1", ""])).toBeNull();
  });
});
