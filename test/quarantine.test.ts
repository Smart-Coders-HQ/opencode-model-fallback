import { afterEach, describe, expect, it } from "bun:test";
import { Logger } from "../src/logging/logger.js";
import { tryPreemptiveRedirect } from "../src/preemptive.js";
import { attemptFallback } from "../src/replay/orchestrator.js";
import { resolveFallbackModel } from "../src/resolution/fallback-resolver.js";
import { ModelHealthStore } from "../src/state/model-health.js";
import { FallbackStore } from "../src/state/store.js";
import type { PluginConfig } from "../src/types.js";
import { makeMockClient, makeUserMessage } from "./helpers/mock-client.js";

const healthStores: ModelHealthStore[] = [];
const fallbackStores: FallbackStore[] = [];

function makeHealth() {
  const store = new ModelHealthStore();
  healthStores.push(store);
  return store;
}

function makeConfig(quarantineAfterFallbackMs = 60_000): PluginConfig {
  return {
    enabled: true,
    defaults: {
      fallbackOn: ["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"],
      cooldownMs: 300_000,
      retryOriginalAfterMs: 900_000,
      maxFallbackDepth: 3,
      retriesBeforeFallback: 0,
      quarantineAfterFallbackMs: 0,
      retriesBeforeFallback: 3,
      quarantineAfterFallbackMs,
    },
    agents: {
      coder: {
        fallbackModels: ["anthropic/claude-sonnet-4", "google/gemini-flash"],
      },
      "*": { fallbackModels: ["anthropic/claude-sonnet-4"] },
    },
    patterns: ["rate limit"],
    logging: false,
    logLevel: "info",
    logPath: "/tmp/test-fallback.log",
    agentDirs: [],
  };
}

function makeFallbackStore(config: PluginConfig) {
  const { client } = makeMockClient();
  const logger = new Logger(client, "/tmp/test.log", false);
  const store = new FallbackStore(config, logger);
  fallbackStores.push(store);
  return store;
}

function tick(store: ModelHealthStore) {
  (store as unknown as { tick(): void }).tick();
}

function sleep(ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    /* busy-wait */
  }
}

afterEach(() => {
  for (const s of fallbackStores) s.destroy();
  fallbackStores.length = 0;
  for (const s of healthStores) s.destroy();
  healthStores.length = 0;
});

describe("ModelHealthStore quarantine", () => {
  it("defaults quarantinedUntil to null", () => {
    const store = makeHealth();
    expect(store.get("a/1").quarantinedUntil).toBeNull();
  });

  it("blocks isUsable and scores 0 while quarantined", () => {
    const store = makeHealth();
    store.quarantine("a/1", 60_000);

    expect(store.isQuarantined("a/1")).toBe(true);
    expect(store.isUsable("a/1")).toBe(false);
    expect(store.preferScore("a/1")).toBe(0);
  });

  it("clears an expired quarantine on tick", () => {
    const store = makeHealth();
    store.quarantine("a/1", 1);
    sleep(5);
    tick(store);

    expect(store.isQuarantined("a/1")).toBe(false);
    expect(store.get("a/1").quarantinedUntil).toBeNull();
    expect(store.isUsable("a/1")).toBe(true);
  });

  it("is a no-op when duration is <= 0", () => {
    const store = makeHealth();
    store.quarantine("a/1", 0);
    store.quarantine("a/2", -100);

    expect(store.isQuarantined("a/1")).toBe(false);
    expect(store.isQuarantined("a/2")).toBe(false);
    expect(store.get("a/1").quarantinedUntil).toBeNull();
  });
});

describe("resolveFallbackModel quarantine", () => {
  it("skips a quarantined preferred model", () => {
    const store = makeHealth();
    store.quarantine("a/2", 60_000);

    const result = resolveFallbackModel(["a/1", "a/2", "a/3"], "a/1", store);
    expect(result).toBe("a/3");
  });

  it("returns null when every candidate is quarantined", () => {
    const store = makeHealth();
    store.quarantine("a/2", 60_000);
    store.quarantine("a/3", 60_000);

    expect(resolveFallbackModel(["a/1", "a/2", "a/3"], "a/1", store)).toBeNull();
  });
});

describe("quarantine integration", () => {
  it("preemptive redirect leaves a quarantined model", () => {
    const config = makeConfig();
    const store = makeFallbackStore(config);
    const { client } = makeMockClient();
    const logger = new Logger(client, "/tmp/test.log", false);

    store.health.quarantine("openai/gpt-5.3-codex", 60_000);

    const result = tryPreemptiveRedirect(
      "s1",
      "openai/gpt-5.3-codex",
      "coder",
      store,
      config,
      logger
    );

    expect(result.redirected).toBe(true);
    expect(result.fallbackModel).toBe("anthropic/claude-sonnet-4");
  });

  it("attemptFallback quarantines the model left behind for non-rate-limit reasons", async () => {
    const config = makeConfig();
    const store = makeFallbackStore(config);
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "timeout",
      client,
      store,
      config,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(true);
    const health = store.health.get("openai/gpt-5.3-codex");
    expect(health.state).toBe("healthy");
    expect(store.health.isQuarantined("openai/gpt-5.3-codex")).toBe(true);
  });

  it("attemptFallback still rate-limits quota_exceeded and quarantines", async () => {
    const config = makeConfig();
    const store = makeFallbackStore(config);
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const logger = new Logger(client, "/tmp/test.log", false);

    await attemptFallback("s1", "quota_exceeded", client, store, config, logger, "/tmp");

    const health = store.health.get("openai/gpt-5.3-codex");
    expect(health.state).toBe("rate_limited");
    expect(store.health.isQuarantined("openai/gpt-5.3-codex")).toBe(true);
  });
});