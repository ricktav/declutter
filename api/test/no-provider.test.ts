import { describe, expect, it } from "vitest";
import { getModel } from "../lib/ai";

describe("test environment", () => {
  it("has no LLM provider, so tests can never reach a paid one", async () => {
    await expect(getModel()).rejects.toThrow(/No LLM configured/);
  });
});
