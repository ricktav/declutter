import { afterEach, describe, expect, it } from "vitest";
import { claudeLabelPrompt } from "../claudeLabel";
import {
  OWL_V2_MODEL,
  OWL_VIT_MODEL,
  defaultThresholdFor,
  isFlorenceEnabled,
  mergeDetections,
  resolveOwlModel,
  resolveOwlThreshold,
  type LocalDetection,
} from "../localDetector";

const ENV_KEYS = ["LOCAL_DETECTOR_MODEL", "LOCAL_DETECTOR_THRESHOLD", "LOCAL_DETECTOR_FLORENCE"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (key in saved) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  }
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("resolveOwlModel", () => {
  it("defaults to OWLv2 and accepts owlvit / owlv2 aliases", () => {
    setEnv("LOCAL_DETECTOR_MODEL", undefined);
    expect(resolveOwlModel()).toBe(OWL_V2_MODEL);
    expect(resolveOwlModel("owlvit")).toBe(OWL_VIT_MODEL);
    expect(resolveOwlModel("owl-vit")).toBe(OWL_VIT_MODEL);
    expect(resolveOwlModel("owlv2")).toBe(OWL_V2_MODEL);
    expect(resolveOwlModel("Xenova/owlvit-base-patch32")).toBe(OWL_VIT_MODEL);
  });

  it("reads LOCAL_DETECTOR_MODEL when no option is passed, and the option wins", () => {
    setEnv("LOCAL_DETECTOR_MODEL", "owlvit");
    expect(resolveOwlModel()).toBe(OWL_VIT_MODEL);
    expect(resolveOwlModel("owlv2")).toBe(OWL_V2_MODEL);
  });
});

describe("resolveOwlThreshold", () => {
  it("uses 0.30 for OWLv2 and 0.12 for the legacy OWL-ViT path", () => {
    setEnv("LOCAL_DETECTOR_THRESHOLD", undefined);
    expect(defaultThresholdFor(OWL_V2_MODEL)).toBe(0.3);
    expect(defaultThresholdFor("owlvit")).toBe(0.12);
    expect(resolveOwlThreshold(OWL_V2_MODEL)).toBe(0.3);
    expect(resolveOwlThreshold(OWL_VIT_MODEL)).toBe(0.12);
  });

  it("lets an explicit threshold or LOCAL_DETECTOR_THRESHOLD override the default", () => {
    setEnv("LOCAL_DETECTOR_THRESHOLD", "0.4");
    expect(resolveOwlThreshold(OWL_V2_MODEL)).toBe(0.4);
    expect(resolveOwlThreshold(OWL_V2_MODEL, 0.25)).toBe(0.25);
  });
});

describe("isFlorenceEnabled", () => {
  it("defaults on and honours opts over LOCAL_DETECTOR_FLORENCE", () => {
    setEnv("LOCAL_DETECTOR_FLORENCE", undefined);
    expect(isFlorenceEnabled()).toBe(true);
    setEnv("LOCAL_DETECTOR_FLORENCE", "0");
    expect(isFlorenceEnabled()).toBe(false);
    expect(isFlorenceEnabled({ florence: true })).toBe(true);
    expect(isFlorenceEnabled({ florence: false })).toBe(false);
  });
});

const mid = { xPct: 50, yPct: 50, wPct: 20, hPct: 20 };
const near = { xPct: 52, yPct: 50, wPct: 20, hPct: 20 };
const far = { xPct: 15, yPct: 15, wPct: 12, hPct: 12 };

function det(label: string, score: number, box: LocalDetection["box"], source: LocalDetection["source"] = "owl"): LocalDetection {
  return { label, score, box, source };
}

describe("mergeDetections", () => {
  it("keeps a known-name OWL hit when Florence overlaps it, even if Florence scored higher", () => {
    const owl = [det("Mac mini", 0.42, mid)];
    const florence = [det("computer", 0.99, near, "florence")];
    const merged = mergeDetections(owl, florence, { preferLabels: ["Mac mini"] });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("Mac mini");
    expect(merged[0]?.source).toBe("owl");
  });

  it("adds a Florence box that does not overlap anything", () => {
    const owl = [det("Mac mini", 0.5, mid)];
    const florence = [det("bottle", 0, far, "florence")];
    const merged = mergeDetections(owl, florence, { preferLabels: ["Mac mini"] });
    expect(merged.map((d) => d.label)).toEqual(["Mac mini", "bottle"]);
  });

  it("drops a Florence box that overlaps a generic OWL hit (existing score NMS)", () => {
    const owl = [det("box", 0.4, mid)];
    const florence = [det("storage box", 0, near, "florence")];
    const merged = mergeDetections(owl, florence);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("box");
  });

  it("keeps a non-overlapping generic OWL hit next to a preferred known-name hit", () => {
    const owl = [det("Mac mini", 0.5, mid), det("box", 0.4, far)];
    const florence = [det("computer", 0.9, near, "florence")];
    const merged = mergeDetections(owl, florence, { preferLabels: ["Mac mini"] });
    expect(merged.map((d) => d.label)).toEqual(["Mac mini", "box"]);
  });

  it("NMS-es two overlapping Florence boxes and keeps the first when scores tie", () => {
    const a = det("keyboard", 0, mid, "florence");
    const b = det("laptop", 0, near, "florence");
    const merged = mergeDetections([], [a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("keyboard");
  });

  it("matches preferred labels case-insensitively", () => {
    const owl = [det("Mac mini", 0.4, mid)];
    const florence = [det("pc", 1, near, "florence")];
    expect(mergeDetections(owl, florence, { preferLabels: ["mac mini"] })[0]?.label).toBe("Mac mini");
  });
});

describe("claudeLabelPrompt", () => {
  it("leaves the base prompt alone without a hint, and mentions a Florence label when given one", () => {
    expect(claudeLabelPrompt()).not.toMatch(/local detector/i);
    expect(claudeLabelPrompt("storage box")).toMatch(/storage box/);
    expect(claudeLabelPrompt("  ")).not.toMatch(/local detector/i);
  });
});
