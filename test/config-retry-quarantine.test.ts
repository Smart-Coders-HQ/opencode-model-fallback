import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAgentFallbackConfigs } from "../src/config/agent-loader.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { mergeWithDefaults, parseConfig } from "../src/config/schema.js";

describe("retry/quarantine config", () => {
  it("defaults retriesBeforeFallback to 0", () => {
    expect(DEFAULT_CONFIG.defaults.retriesBeforeFallback).toBe(0);
    expect(mergeWithDefaults({}).defaults.retriesBeforeFallback).toBe(0);
  });

  it("defaults quarantineAfterFallbackMs to 0", () => {
    expect(DEFAULT_CONFIG.defaults.quarantineAfterFallbackMs).toBe(0);
    expect(mergeWithDefaults({}).defaults.quarantineAfterFallbackMs).toBe(0);
  });

  it("accepts retriesBeforeFallback within 0-10", () => {
    const { config, warnings } = parseConfig({
      defaults: { retriesBeforeFallback: 3 },
    });
    expect(warnings).toHaveLength(0);
    expect(config.defaults?.retriesBeforeFallback).toBe(3);
  });

  it("rejects retriesBeforeFallback below 0", () => {
    const { config, warnings } = parseConfig({ defaults: { retriesBeforeFallback: -1 } });
    expect(config.defaults?.retriesBeforeFallback).toBeUndefined();
    expect(warnings.some((w) => w.includes("defaults.retriesBeforeFallback"))).toBe(true);
  });

  it("rejects retriesBeforeFallback above 10", () => {
    const { config, warnings } = parseConfig({ defaults: { retriesBeforeFallback: 11 } });
    expect(config.defaults?.retriesBeforeFallback).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects non-integer retriesBeforeFallback", () => {
    const { config, warnings } = parseConfig({ defaults: { retriesBeforeFallback: 1.5 } });
    expect(config.defaults?.retriesBeforeFallback).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("accepts quarantineAfterFallbackMs >= 0", () => {
    const { config, warnings } = parseConfig({
      defaults: { quarantineAfterFallbackMs: 21_600_000 },
    });
    expect(warnings).toHaveLength(0);
    expect(config.defaults?.quarantineAfterFallbackMs).toBe(21_600_000);
  });

  it("accepts quarantineAfterFallbackMs of 0", () => {
    const { config, warnings } = parseConfig({
      defaults: { quarantineAfterFallbackMs: 0 },
    });
    expect(warnings).toHaveLength(0);
    expect(config.defaults?.quarantineAfterFallbackMs).toBe(0);
  });

  it("rejects negative quarantineAfterFallbackMs", () => {
    const { config, warnings } = parseConfig({
      defaults: { quarantineAfterFallbackMs: -1 },
    });
    expect(config.defaults?.quarantineAfterFallbackMs).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("merges explicit retry/quarantine values", () => {
    const result = mergeWithDefaults({
      defaults: { retriesBeforeFallback: 4, quarantineAfterFallbackMs: 1_000 },
    });
    expect(result.defaults.retriesBeforeFallback).toBe(4);
    expect(result.defaults.quarantineAfterFallbackMs).toBe(1_000);
  });
});
describe("relaxed model key regex", () => {
  const accepted = [
    "anthropic/claude-sonnet-4-20250514",
    "openrouter/anthropic/claude-3.5-sonnet",
    "openrouter/openrouter/free",
    "openrouter/~deepseek/deepseek-flash-latest",
    "github-copilot/claude-sonnet-4.5",
    "local/qwen3:32b",
    "huggingface/org/model~v1",
    "openai/gpt-5.3-codex",
    "zai-coding-plan/glm-5",
  ];

  for (const key of accepted) {
    it(`accepts ${key} in config agents`, () => {
      const { config, warnings } = parseConfig({
        agents: { "*": { fallbackModels: [key] } },
      });
      expect(warnings).toHaveLength(0);
      expect(config.agents?.["*"].fallbackModels).toEqual([key]);
    });
  }

  it("rejects keys with invalid characters", () => {
    const { warnings } = parseConfig({
      agents: { "*": { fallbackModels: ["bad model/with space"] } },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("relaxed model key regex in agent-loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loader-regex-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps model keys with dots, colons, tildes, and slashes", () => {
    const agentsDir = join(dir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "coder.md"),
      `---
name: CoderAgent
fallback:
  models:
    - openrouter/anthropic/claude-3.5-sonnet
    - local/qwen3:32b
    - huggingface/org/model~v1
---
`,
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs.CoderAgent.fallbackModels).toEqual([
      "openrouter/anthropic/claude-3.5-sonnet",
      "local/qwen3:32b",
      "huggingface/org/model~v1",
    ]);
  });
});
