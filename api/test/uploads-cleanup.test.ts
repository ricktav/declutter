// api/test/uploads-cleanup.test.ts
import fs from "fs";
import { describe, expect, it } from "vitest";
import { putFile, withNewFile } from "../lib/filestore";
import { keyPath, trackedUploads } from "./fixtures";

// No afterEach here on purpose: api/test/setup.ts must clean up by itself.
let written = "";

describe("files the app writes during a test", () => {
  it("are tracked as they are written", async () => {
    written = (await putFile({ bytes: new Uint8Array([1, 2, 3]), fileName: "items/1/cutout-1.jpg" })).key;
    expect(trackedUploads()).toContain(written);
    expect(fs.existsSync(keyPath(written))).toBe(true);
  });

  it("are gone before the next test starts", () => {
    expect(written).not.toBe("");
    expect(fs.existsSync(keyPath(written))).toBe(false);
  });
});

describe("withNewFile", () => {
  it("deletes the new file when the row write throws", async () => {
    let key = "";
    await expect(
      withNewFile({ bytes: new Uint8Array([1, 2, 3]), fileName: "items/9/cutout-x.jpg" }, async (saved) => {
        key = saved.key;
        throw new Error("insert failed");
      }),
    ).rejects.toThrow("insert failed");
    expect(key).not.toBe("");
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });

  it("keeps the file and returns the write's result when the write succeeds", async () => {
    const res = await withNewFile({ bytes: new Uint8Array([4, 5]), fileName: "items/9/cutout-y.jpg" }, async (saved) => saved);
    expect(res.size).toBe(2);
    expect(fs.existsSync(keyPath(res.key))).toBe(true);
  });
});
