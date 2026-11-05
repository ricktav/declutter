import { afterEach, describe, expect, it } from "vitest";
import { claudeLabelPrompt } from "../claudeLabel";
import {
  OWL_V2_MODEL,
  OWL_VIT_MODEL,
  defaultFlorenceReserve,
  defaultThresholdFor,
  dedupeKnownDetections,
  finalizeDetections,
  isFlorenceEnabled,
  mergeDetections,
  resolveOwlModel,
  resolveOwlThreshold,
  selectBoundedDetections,
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

const left = { xPct: 20, yPct: 70, wPct: 10, hPct: 10 };
const right = { xPct: 80, yPct: 70, wPct: 10, hPct: 10 };

describe("dedupeKnownDetections", () => {
  it("keeps the highest-score box when the same known name fires twice", () => {
    const a = det("Mac mini", 0.4, mid);
    const b = det("Mac mini", 0.6, far);
    const out = dedupeKnownDetections([a, b], ["Mac mini"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.score).toBe(0.6);
  });

  it("does not collapse distinct unknown objects that share a generic label", () => {
    const a = det("bottle", 0, left, "florence");
    const b = det("bottle", 0, right, "florence");
    const out = dedupeKnownDetections([a, b], ["Mac mini"]);
    expect(out).toHaveLength(2);
  });
});

describe("selectBoundedDetections", () => {
  it("reserves Florence seats when known OWL would otherwise fill maxResults", () => {
    expect(defaultFlorenceReserve(10)).toBe(3);
    const known = Array.from({ length: 12 }, (_, i) =>
      det(`Thing ${i}`, 0.5, { xPct: 10 + i, yPct: 10, wPct: 4, hPct: 4 }),
    );
    const florence = [
      det("cable", 0, left, "florence"),
      det("mug", 0, right, "florence"),
      det("plant", 0, far, "florence"),
    ];
    const labels = known.map((d) => d.label);
    const out = selectBoundedDetections([...known, ...florence], {
      maxResults: 10,
      knownLabels: labels,
      florenceReserve: 3,
    });
    expect(out).toHaveLength(10);
    expect(out.filter((d) => d.source === "florence")).toHaveLength(3);
    expect(out.filter((d) => d.source !== "florence")).toHaveLength(7);
  });

  it("gives unused Florence seats back to known hits", () => {
    const known = Array.from({ length: 12 }, (_, i) => det(`Thing ${i}`, 0.5, { xPct: 8 + i * 3, yPct: 20, wPct: 3, hPct: 3 }));
    const out = selectBoundedDetections(known, { maxResults: 10, knownLabels: known.map((d) => d.label), florenceReserve: 3 });
    expect(out).toHaveLength(10);
    expect(out.every((d) => d.source === "owl")).toBe(true);
  });

  it("prefers leftover Florence over extra generic OWL when the cap is full", () => {
    const known = Array.from({ length: 8 }, (_, i) => det(`Thing ${i}`, 0.6, { xPct: 8 + i * 4, yPct: 20, wPct: 3, hPct: 3 }));
    const generic = Array.from({ length: 5 }, (_, i) => det(`box ${i}`, 0.4, { xPct: 8 + i * 4, yPct: 80, wPct: 3, hPct: 3 }));
    const florence = [det("cable", 0, left, "florence"), det("mug", 0, right, "florence"), det("plant", 0, far, "florence")];
    const out = selectBoundedDetections([...known, ...generic, ...florence], {
      maxResults: 10,
      knownLabels: known.map((d) => d.label),
      florenceReserve: 3,
    });
    expect(out.filter((d) => d.source === "florence").map((d) => d.label)).toEqual(["cable", "mug", "plant"]);
    expect(out.filter((d) => d.label.startsWith("Thing"))).toHaveLength(7);
    expect(out.some((d) => d.label.startsWith("box"))).toBe(false);
  });
});

describe("finalizeDetections", () => {
  it("keeps the known match on overlap, drops extra copies of it, and still seats Florence", () => {
    const owl = [
      det("Mac mini", 0.45, mid),
      det("Mac mini", 0.55, near),
      ...Array.from({ length: 12 }, (_, i) => det(`Lamp ${i}`, 0.4, { xPct: 5 + i * 6, yPct: 10, wPct: 4, hPct: 4 })),
    ];
    const florence = [det("stapler", 0, { xPct: 90, yPct: 90, wPct: 8, hPct: 8 }, "florence")];
    const known = ["Mac mini", ...owl.slice(2).map((d) => d.label)];
    const out = finalizeDetections(owl, florence, { knownLabels: known, maxResults: 10, florenceReserve: 3 });
    expect(out.filter((d) => d.label === "Mac mini")).toHaveLength(1);
    expect(out.some((d) => d.label === "stapler")).toBe(true);
    expect(out).toHaveLength(10);
  });
});
