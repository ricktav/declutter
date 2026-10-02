import { describe, expect, it } from "vitest";
import { requireTestDatabaseUrl } from "./db";

const prod = "mysql://u:p@db.local:3306/declutter";

describe("requireTestDatabaseUrl", () => {
  it("throws when TEST_DATABASE_URL is unset", () => {
    expect(() => requireTestDatabaseUrl({ DATABASE_URL: prod })).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("throws when it is the same database as DATABASE_URL, even with a different spelling", () => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: prod, DATABASE_URL: prod })).toThrow(/same database/);
    expect(() =>
      requireTestDatabaseUrl({ TEST_DATABASE_URL: "mysql://u:p@db.local/declutter", DATABASE_URL: prod }),
    ).toThrow(/same database/);
  });

  it("throws when the database name does not end in _test", () => {
    expect(() =>
      requireTestDatabaseUrl({ TEST_DATABASE_URL: "mysql://u:p@db.local:3306/declutter_staging", DATABASE_URL: prod }),
    ).toThrow(/must end in _test/);
  });

  it("throws on a malformed URL", () => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: "not a url", DATABASE_URL: prod })).toThrow(/not a valid/);
  });

  it("returns the value for a distinct _test database on the same host", () => {
    const t = "mysql://u:p@db.local:3306/declutter_test";
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: t, DATABASE_URL: prod })).toBe(t);
  });

  it("returns the value when DATABASE_URL is unset entirely", () => {
    const t = "mysql://u:p@db.local:3306/declutter_test";
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: t })).toBe(t);
  });
});
