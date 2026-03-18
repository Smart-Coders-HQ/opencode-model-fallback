import { afterEach, describe, expect, it } from "bun:test";
import type { Event } from "@opencode-ai/sdk";
import { Logger } from "../src/logging/logger.js";
import { handleEvent, handleIdle } from "../src/plugin.js";
import { FallbackStore } from "../src/state/store.js";
import type { PluginConfig } from "../src/types.js";
import { makeMockClient } from "./helpers/mock-client.js";

const BASE_CONFIG: PluginConfig = {
  enabled: true,
  defaults: {
    fallbackOn: ["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"],
    cooldownMs: 300_000,
    retryOriginalAfterMs: 900_000,
    maxFallbackDepth: 3,
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

const stores: FallbackStore[] = [];

function makeStore(config = BASE_CONFIG) {
  const { client } = makeMockClient();
  const logger = new Logger(client, "/tmp/test.log", false);
  const store = new FallbackStore(config, logger);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.destroy();
  stores.length = 0;
});

describe("plugin event handling", () => {
  it("handles malformed APIError payloads without throwing", async () => {
    const { client, calls } = makeMockClient();
    const store = makeStore();
    const logger = new Logger(client, "/tmp/test.log", false);

    const malformedErrorEvent = {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "APIError",
          data: {},
        },
      },
    } as unknown as Event;

    await handleEvent(malformedErrorEvent, client, store, BASE_CONFIG, logger, "/tmp");

    expect(calls.prompt).toHaveLength(0);
  });

  it("sends only one recovery toast across repeated idle events", async () => {
    const { client, calls } = makeMockClient();
    const store = makeStore();
    const logger = new Logger(client, "/tmp/test.log", false);

    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const sessionState = store.sessions.get("s1");
    sessionState.currentModel = "anthropic/claude-sonnet-4";

    await handleIdle("s1", client, store, BASE_CONFIG, logger);
    await handleIdle("s1", client, store, BASE_CONFIG, logger);

    expect(calls.toasts).toHaveLength(1);
    expect(sessionState.recoveryNotifiedForModel).toBe("openai/gpt-5.3-codex");
  });

  it("session.compacted event clears fallbackHistory and lastFallbackAt", async () => {
    const { client } = makeMockClient();
    const store = makeStore();
    const logger = new Logger(client, "/tmp/test.log", false);

    // Seed session with fallback state
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    store.sessions.recordFallback(
      "s1",
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4",
      "rate_limit",
      "coder"
    );
    store.sessions.recordFallback(
      "s1",
      "anthropic/claude-sonnet-4",
      "google/gemini-flash",
      "rate_limit",
      "coder"
    );

    const beforeCompaction = store.sessions.get("s1");
    expect(beforeCompaction.fallbackHistory).toHaveLength(2);
    expect(beforeCompaction.lastFallbackAt).not.toBeNull();
    expect(beforeCompaction.fallbackDepth).toBe(2);

    // Fire session.compacted event
    const compactedEvent = {
      type: "session.compacted",
      properties: {
        sessionID: "s1",
      },
    } as unknown as Event;

    await handleEvent(compactedEvent, client, store, BASE_CONFIG, logger, "/tmp");

    // Verify: fallbackHistory is empty, lastFallbackAt is null, isProcessing is false
    const afterCompaction = store.sessions.get("s1");
    expect(afterCompaction.fallbackHistory).toHaveLength(0);
    expect(afterCompaction.lastFallbackAt).toBeNull();
    expect(afterCompaction.isProcessing).toBe(false);
  });

  it("session.compacted event preserves originalModel, currentModel, agentName, fallbackDepth", async () => {
    const { client } = makeMockClient();
    const store = makeStore();
    const logger = new Logger(client, "/tmp/test.log", false);

    // Seed session with full state
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    store.sessions.setAgentName("s1", "coder");
    store.sessions.recordFallback(
      "s1",
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-4",
      "rate_limit",
      "coder"
    );

    const beforeCompaction = store.sessions.get("s1");
    expect(beforeCompaction.originalModel).toBe("openai/gpt-5.3-codex");
    expect(beforeCompaction.currentModel).toBe("anthropic/claude-sonnet-4");
    expect(beforeCompaction.agentName).toBe("coder");
    expect(beforeCompaction.fallbackDepth).toBe(1);

    // Fire session.compacted event
    const compactedEvent = {
      type: "session.compacted",
      properties: {
        sessionID: "s1",
      },
    } as unknown as Event;

    await handleEvent(compactedEvent, client, store, BASE_CONFIG, logger, "/tmp");

    // Verify: originalModel, currentModel, agentName, fallbackDepth are PRESERVED
    const afterCompaction = store.sessions.get("s1");
    expect(afterCompaction.originalModel).toBe("openai/gpt-5.3-codex");
    expect(afterCompaction.currentModel).toBe("anthropic/claude-sonnet-4");
    expect(afterCompaction.agentName).toBe("coder");
    expect(afterCompaction.fallbackDepth).toBe(1);
  });
});
