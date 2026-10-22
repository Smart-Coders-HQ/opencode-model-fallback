import { afterEach, describe, expect, it } from "bun:test";
import type { Event } from "@opencode-ai/sdk";
import { Logger } from "../src/logging/logger.js";
import { handleEvent, shouldDeferFallback } from "../src/plugin.js";
import { FallbackStore } from "../src/state/store.js";
import type { PluginConfig } from "../src/types.js";
import { makeMockClient, makeUserMessage } from "./helpers/mock-client.js";

function makeConfig(retriesBeforeFallback = 3): PluginConfig {
  return {
    enabled: true,
    defaults: {
      fallbackOn: ["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"],
      cooldownMs: 300_000,
      retryOriginalAfterMs: 900_000,
      maxFallbackDepth: 3,
      retriesBeforeFallback: 0,
      quarantineAfterFallbackMs: 0,
      retriesBeforeFallback,
      quarantineAfterFallbackMs: 0,
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

const stores: FallbackStore[] = [];

function makeStore(config: PluginConfig) {
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

function retryEvent(attempt: unknown): Event {
  return {
    type: "session.status",
    properties: {
      sessionID: "s1",
      status: {
        type: "retry",
        attempt,
        message: "rate limit exceeded",
        next: Date.now(),
      },
    },
  } as unknown as Event;
}

describe("shouldDeferFallback", () => {
  it("defers when attempt is within the retry budget", () => {
    expect(shouldDeferFallback(1, 3)).toBe(true);
    expect(shouldDeferFallback(3, 3)).toBe(true);
  });

  it("falls back once attempt exceeds the retry budget", () => {
    expect(shouldDeferFallback(4, 3)).toBe(false);
  });

  it("falls back immediately when the budget is 0", () => {
    expect(shouldDeferFallback(1, 0)).toBe(false);
    expect(shouldDeferFallback(4, 0)).toBe(false);
  });

  it("follows the raw comparison for attempt 0", () => {
    expect(shouldDeferFallback(0, 0)).toBe(true);
  });

  it("falls back immediately for undefined attempt (backward compatible)", () => {
    expect(shouldDeferFallback(undefined, 3)).toBe(false);
  });
});

describe("handleEvent retry gate", () => {
  it("defers fallback on attempts within the retry budget", async () => {
    const config = makeConfig(3);
    const store = makeStore(config);
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, "/tmp/test.log", false);

    await handleEvent(retryEvent(1), client, store, config, logger, "/tmp");
    await handleEvent(retryEvent(3), client, store, config, logger, "/tmp");

    expect(calls.prompt).toHaveLength(0);
    expect(calls.abort).toHaveLength(0);
  });

  it("falls back after the retry budget is exhausted", async () => {
    const config = makeConfig(3);
    const store = makeStore(config);
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const logger = new Logger(client, "/tmp/test.log", false);

    await handleEvent(retryEvent(4), client, store, config, logger, "/tmp");

    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0].modelID).toBe("claude-sonnet-4");
  });

  it("falls back immediately when attempt is missing", async () => {
    const config = makeConfig(3);
    const store = makeStore(config);
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const logger = new Logger(client, "/tmp/test.log", false);

    await handleEvent(retryEvent(undefined), client, store, config, logger, "/tmp");

    expect(calls.prompt).toHaveLength(1);
  });

  it("session.error still falls back regardless of the retry gate", async () => {
    const config = makeConfig(3);
    const store = makeStore(config);
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const logger = new Logger(client, "/tmp/test.log", false);

    const errorEvent = {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: {
          name: "APIError",
          data: { message: "rate limit exceeded", statusCode: 429 },
        },
      },
    } as unknown as Event;

    await handleEvent(errorEvent, client, store, config, logger, "/tmp");

    expect(calls.prompt).toHaveLength(1);
  });
});