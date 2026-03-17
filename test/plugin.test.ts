import { afterEach, describe, expect, it } from "bun:test";
import type { Event } from "@opencode-ai/sdk";
import { handleEvent, handleIdle } from "../src/plugin.js";
import { Logger } from "../src/logging/logger.js";
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
});
