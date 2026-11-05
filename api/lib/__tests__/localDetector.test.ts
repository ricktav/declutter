import { afterEach, describe, expect, it } from "vitest";
import {
  OWL_V2_MODEL,
  OWL_VIT_MODEL,
  defaultThresholdFor,
  resolveOwlModel,
  resolveOwlThreshold,
} from "../localDetector";

const ENV_KEYS = ["LOCAL_DETECTOR_MODEL", "LOCAL_DETECTOR_THRESHOLD"] as const;
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
