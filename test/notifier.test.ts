import { describe, expect, it } from "bun:test";
import { labelModel } from "../src/display/notifier.js";

describe("labelModel", () => {
  it("formats provider in brackets", () => {
    expect(labelModel("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5 [anthropic]");
    expect(labelModel("openrouter/claude-sonnet-4-5")).toBe("claude-sonnet-4-5 [openrouter]");
    expect(labelModel("google/gemini-flash")).toBe("gemini-flash [google]");
  });

  it("handles key without slash", () => {
    expect(labelModel("bare-model")).toBe("bare-model");
  });
});
