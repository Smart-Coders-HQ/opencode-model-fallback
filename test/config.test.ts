import { describe, expect, it } from "bun:test";
import { homedir } from "os";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { isOldFormat, migrateOldConfig } from "../src/config/migrate.js";
import { mergeWithDefaults, parseConfig } from "../src/config/schema.js";

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    const raw = {
      enabled: true,
      agents: {
        "*": { fallbackModels: ["anthropic/claude-sonnet-4-20250514"] },
      },
      patterns: ["rate limit"],
      logging: false,
    };
    const { config, warnings } = parseConfig(raw);
    expect(warnings).toHaveLength(0);
    expect(config.enabled).toBe(true);
  });

  it("rejects invalid model key", () => {
    const raw = {
      agents: { "*": { fallbackModels: ["not-valid"] } },
    };
    const { warnings } = parseConfig(raw);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects cooldownMs below minimum", () => {
    const raw = {
      defaults: { cooldownMs: 100 },
    };
    const { warnings } = parseConfig(raw);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("rejects maxFallbackDepth above maximum", () => {
    const raw = {
      defaults: { maxFallbackDepth: 99 },
    };
    const { warnings } = parseConfig(raw);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("returns empty config on parse failure", () => {
    const { config, warnings } = parseConfig({ unknown_field: true });
    expect(warnings.length).toBeGreaterThan(0);
    expect(config).toEqual({});
  });

  it("keeps valid fields when one field is invalid", () => {
    const raw = {
      enabled: false,
      logging: true,
      defaults: {
        cooldownMs: 100,
        retryOriginalAfterMs: 120_000,
      },
    };

    const { config, warnings } = parseConfig(raw);

    expect(config.enabled).toBe(false);
    expect(config.logging).toBe(true);
    expect(config.defaults?.retryOriginalAfterMs).toBe(120_000);
    expect(config.defaults?.cooldownMs).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("defaults.cooldownMs"))).toBe(true);
  });

  it("handles config with valid enabled:false and invalid cooldownMs", () => {
    const raw = {
      enabled: false,
      defaults: { cooldownMs: -1 },
    };

    const { config, warnings } = parseConfig(raw);

    expect(config.enabled).toBe(false);
    expect(config.defaults?.cooldownMs).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("cooldownMs"))).toBe(true);
  });

  it("handles config with agents: null", () => {
    const raw = {
      agents: null,
    };

    const { config, warnings } = parseConfig(raw);

    expect(warnings.length).toBeGreaterThan(0);
    expect(config.agents).toBeUndefined();
  });
});

describe("mergeWithDefaults", () => {
  it("uses defaults for missing fields", () => {
    const result = mergeWithDefaults({});
    expect(result.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(result.defaults.cooldownMs).toBe(DEFAULT_CONFIG.defaults.cooldownMs);
  });

  it("overrides defaults with provided values", () => {
    const result = mergeWithDefaults({
      enabled: false,
      defaults: { cooldownMs: 60_000 },
    });
    expect(result.enabled).toBe(false);
    expect(result.defaults.cooldownMs).toBe(60_000);
    // Other defaults preserved
    expect(result.defaults.maxFallbackDepth).toBe(DEFAULT_CONFIG.defaults.maxFallbackDepth);
  });

  it("expands ~/ in logPath", () => {
    const result = mergeWithDefaults({
      logPath: "~/.local/share/opencode/test.log",
    });
    expect(result.logPath.startsWith(homedir())).toBe(true);
    expect(result.logPath).not.toContain("~/");
  });
});

describe("migration", () => {
  it("detects old format", () => {
    expect(isOldFormat({ fallbackModel: "anthropic/claude-opus-4" })).toBe(true);
    expect(isOldFormat({ agents: {} })).toBe(false);
    expect(isOldFormat(null)).toBe(false);
  });

  it("migrates old format to new", () => {
    const old = {
      fallbackModel: "anthropic/claude-opus-4",
      cooldownMs: 120_000,
      patterns: ["rate limit"],
      logging: true,
    };
    const migrated = migrateOldConfig(old);
    expect(migrated.agents).toEqual({
      "*": { fallbackModels: ["anthropic/claude-opus-4"] },
    });
    expect(migrated.defaults).toEqual({ cooldownMs: 120_000 });
    expect(migrated.patterns).toEqual(["rate limit"]);
    expect(migrated.logging).toBe(true);
  });
});
