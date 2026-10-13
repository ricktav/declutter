import { describe, expect, it } from "vitest";
import { IP_REFRESHED_AT, isIpRecent, stampIpRefresh } from "../ipRefresh";

const now = new Date("2026-10-13T12:00:00.000Z");

describe("isIpRecent", () => {
  it("counts a refresh under 24 hours as recent and one of 24 hours or older as not", () => {
    expect(isIpRecent("2026-10-12T12:00:00.001Z", now)).toBe(true);
    expect(isIpRecent("2026-10-13T11:00:00.000Z", now)).toBe(true);
    expect(isIpRecent("2026-10-12T12:00:00.000Z", now)).toBe(false);
    expect(isIpRecent("2026-10-11T12:00:00.000Z", now)).toBe(false);
    expect(isIpRecent(null, now)).toBe(false);
    expect(isIpRecent("", now)).toBe(false);
    expect(isIpRecent("not-a-date", now)).toBe(false);
  });
});

describe("stampIpRefresh", () => {
  it("stamps when the IP changes, keeps the old stamp when it does not, and drops it when the IP is gone", () => {
    const first = stampIpRefresh(null, { role: "laptop", ip: "10.50.0.10" }, now);
    expect(first?.[IP_REFRESHED_AT]).toBe(now.toISOString());

    const kept = stampIpRefresh(first, { role: "laptop", ip: "10.50.0.10", model: "Air", [IP_REFRESHED_AT]: "2099-01-01T00:00:00.000Z" }, now);
    expect(kept?.[IP_REFRESHED_AT]).toBe(now.toISOString());

    const later = new Date("2026-10-13T18:00:00.000Z");
    const changed = stampIpRefresh(kept, { role: "laptop", ip: "10.50.0.11", model: "Air" }, later);
    expect(changed?.[IP_REFRESHED_AT]).toBe(later.toISOString());

    const cleared = stampIpRefresh(changed, { role: "laptop", model: "Air" }, later);
    expect(cleared?.[IP_REFRESHED_AT]).toBeUndefined();
  });

  it("treats a trimmed same address as unchanged", () => {
    const before = { ip: "10.50.0.10", [IP_REFRESHED_AT]: "2026-10-01T00:00:00.000Z" };
    const next = stampIpRefresh(before, { ip: " 10.50.0.10 " }, now);
    expect(next?.[IP_REFRESHED_AT]).toBe("2026-10-01T00:00:00.000Z");
  });
});
