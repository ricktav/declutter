import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callerFor } from "./caller";
import { DEFAULT_LINKS } from "../lib/settings";

let dir: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.DECLUTTER_SETTINGS_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-settings-"));
  process.env.DECLUTTER_SETTINGS_PATH = path.join(dir, "settings.json");
});
afterEach(() => {
  process.env.DECLUTTER_SETTINGS_PATH = before;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("settings.links", () => {
  it("gives the old built-in links until set", async () => {
    expect(await callerFor(null).settings.links()).toEqual(DEFAULT_LINKS);
  });

  it("saves one link without touching the other, and turns it off with an empty string", async () => {
    const c = callerFor(null);
    await c.settings.setLinks({ meterkastUrl: "http://meters.local/live.html", parcelViewerUrl: "https://maps.example/viewer/" });
    await c.settings.setLinks({ meterkastUrl: "http://meters.local/other.html" });
    expect(await c.settings.links()).toEqual({
      meterkastUrl: "http://meters.local/other.html",
      parcelViewerUrl: "https://maps.example/viewer/",
      homebase3dUrl: DEFAULT_LINKS.homebase3dUrl,
    });
    await c.settings.setLinks({ parcelViewerUrl: "" });
    expect(await c.settings.links()).toEqual({
      meterkastUrl: "http://meters.local/other.html",
      parcelViewerUrl: null,
      homebase3dUrl: DEFAULT_LINKS.homebase3dUrl,
    });
  });

  it("uses HOMEBASE_3D_URL when the setting is unset, and an empty setting hides the link", async () => {
    const prev = process.env.HOMEBASE_3D_URL;
    process.env.HOMEBASE_3D_URL = "http://3d.test:3010/";
    try {
      const c = callerFor(null);
      expect((await c.settings.links()).homebase3dUrl).toBe("http://3d.test:3010");
      await c.settings.setLinks({ homebase3dUrl: "https://homebase-3d.example/" });
      expect((await c.settings.links()).homebase3dUrl).toBe("https://homebase-3d.example");
      await c.settings.setLinks({ homebase3dUrl: "" });
      expect((await c.settings.links()).homebase3dUrl).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.HOMEBASE_3D_URL;
      else process.env.HOMEBASE_3D_URL = prev;
    }
  });

  it("refuses anything but an http(s) address", async () => {
    await expect(callerFor(null).settings.setLinks({ meterkastUrl: "javascript:alert(1)" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(null).settings.setLinks({ meterkastUrl: "not a url" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
