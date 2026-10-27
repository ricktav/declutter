import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  hasModel3dUrl,
  homebase3dThingUrl,
  looksLikeAgentModelModule,
  model3dFormatOf,
  resolveModel3dSrc,
} from "../../../src/lib/model3dView";

describe("model3dView helpers", () => {
  it("treats a non-empty URL as a model", () => {
    expect(hasModel3dUrl(null)).toBe(false);
    expect(hasModel3dUrl("")).toBe(false);
    expect(hasModel3dUrl("  ")).toBe(false);
    expect(hasModel3dUrl("/uploads/mug.glb")).toBe(true);
  });

  it("resolves local/ and /uploads/ to a same-origin path, and keeps http(s)", () => {
    expect(resolveModel3dSrc("local/mug.glb")).toBe("/uploads/mug.glb");
    expect(resolveModel3dSrc("/uploads/mug.glb")).toBe("/uploads/mug.glb");
    expect(resolveModel3dSrc("https://cdn.example/x.js")).toBe("https://cdn.example/x.js");
    expect(resolveModel3dSrc("  ")).toBeNull();
    expect(resolveModel3dSrc("ftp://x.glb")).toBeNull();
    expect(resolveModel3dSrc("/fixtures/model3d/cube.glb")).toBeNull();
  });

  it("classifies stored URLs by extension, ignoring query strings", () => {
    expect(model3dFormatOf("https://cdn.example/a.glb?v=1")).toBe("glb");
    expect(model3dFormatOf("/uploads/a.gltf")).toBe("gltf");
    expect(model3dFormatOf("local/a.usdz")).toBe("usdz");
    expect(model3dFormatOf("http://10.50.0.102:3010/models/agent-claude/12.js")).toBe("js");
    expect(model3dFormatOf("/uploads/a.mjs")).toBe("js");
    expect(model3dFormatOf("/uploads/a.bin")).toBe("unknown");
  });

  it("builds the companion Thing URL and rejects a bad base", () => {
    expect(homebase3dThingUrl("http://10.50.0.102:3010/", 51)).toBe("http://10.50.0.102:3010/things/51");
    expect(homebase3dThingUrl("http://10.50.0.102:3010", 51)).toBe("http://10.50.0.102:3010/things/51");
    expect(homebase3dThingUrl(null, 51)).toBeNull();
    expect(homebase3dThingUrl("javascript:alert(1)", 51)).toBeNull();
    expect(homebase3dThingUrl("http://x", 0)).toBeNull();
  });

  it("accepts a route-1 build() export and rejects a random script", () => {
    expect(looksLikeAgentModelModule("export function build(THREE) { return new THREE.Group(); }\n")).toBe(true);
    expect(looksLikeAgentModelModule("export async function build(THREE) { return new THREE.Group(); }\n")).toBe(true);
    expect(looksLikeAgentModelModule("function build(THREE) {}\nexport { build };\n")).toBe(true);
    expect(looksLikeAgentModelModule("/* export function build(THREE) {} */\nexport const x = 1;\n")).toBe(false);
    expect(looksLikeAgentModelModule("console.log('nope')\n")).toBe(false);
    const fixture = fs.readFileSync(path.resolve("public/fixtures/model3d/agent-cube.js"), "utf8");
    expect(looksLikeAgentModelModule(fixture)).toBe(true);
  });

  it("ships a tiny GLB fixture with a glTF header", () => {
    const glb = fs.readFileSync(path.resolve("public/fixtures/model3d/cube.glb"));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.length).toBeGreaterThan(64);
  });
});
