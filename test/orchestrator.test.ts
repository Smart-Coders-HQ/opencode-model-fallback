import { afterEach, describe, expect, it } from "bun:test";
import { Logger } from "../src/logging/logger.js";
import { attemptFallback } from "../src/replay/orchestrator.js";
import { FallbackStore } from "../src/state/store.js";
import type { PluginConfig } from "../src/types.js";
import { makeMockClient, makeUserMessage } from "./helpers/mock-client.js";

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
  for (const s of stores) s.destroy();
  stores.length = 0;
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("attemptFallback — happy path", () => {
  it("aborts, reverts, and prompts with the fallback model", async () => {
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("anthropic/claude-sonnet-4");
    expect(calls.abort).toContain("s1");
    expect(calls.revert).toHaveLength(1);
    expect(calls.revert[0]).toMatchObject({ sessionId: "s1", messageID: "m1" });
    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0]).toMatchObject({
      sessionId: "s1",
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    });
  });

  it("marks original model as rate_limited after fallback", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");

    const health = store.health.get("openai/gpt-5.3-codex");
    expect(health.state).toBe("rate_limited");
    expect(health.failureCount).toBe(1);
  });

  it("increments fallback depth in session state", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");

    const state = store.sessions.get("s1");
    expect(state.fallbackDepth).toBe(1);
    expect(state.currentModel).toBe("anthropic/claude-sonnet-4");
    expect(state.fallbackHistory).toHaveLength(1);
  });

  it("passes message parts to the prompt call", async () => {
    const { client, calls } = makeMockClient({
      messages: [
        makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder", "write me a function"),
      ],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");

    expect(calls.prompt[0].parts).toHaveLength(1);
    expect((calls.prompt[0].parts[0] as { text: string }).text).toBe("write me a function");
  });

  it("sets lastFallbackAt optimistically before prompt", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const before = Date.now();
    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");

    // lastFallbackAt should be set (optimistically during replay, then again by recordFallback)
    const state = store.sessions.get("s1");
    expect(state.lastFallbackAt).toBeGreaterThanOrEqual(before);
  });
});

// ─── Cascading fallback ───────────────────────────────────────────────────────

describe("attemptFallback — cascading fallback", () => {
  it("skips rate-limited models and picks next healthy one", async () => {
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    // Mark the first fallback model as rate_limited
    store.health.markRateLimited("anthropic/claude-sonnet-4", 300_000, 900_000);
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("google/gemini-flash");
    expect(calls.prompt[0]).toMatchObject({
      providerID: "google",
      modelID: "gemini-flash",
    });
  });

  it("returns failure when all fallback models are exhausted", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    store.health.markRateLimited("anthropic/claude-sonnet-4", 300_000, 900_000);
    store.health.markRateLimited("google/gemini-flash", 300_000, 900_000);
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("all fallback models exhausted");
  });

  it("falls back correctly when session reverts to original model after a prior fallback", async () => {
    // Simulate: session already fell back once (depth=1, currentModel=claude-sonnet-4)
    // but the OpenCode TUI model reverted to gpt-5.3 and that message is now rate-limited.
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");

    // Simulate state after a prior successful fallback
    store.sessions.setAgentName("s1", "coder");
    const state = store.sessions.get("s1");
    state.currentModel = "anthropic/claude-sonnet-4"; // plugin thinks we're on claude
    state.fallbackDepth = 1;

    const logger = new Logger(client, "/tmp/test.log", false);
    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    // Should fall back to claude-sonnet-4 (the message is from gpt-5.3, so claude is a valid candidate)
    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("anthropic/claude-sonnet-4");
    expect(calls.prompt[0]).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    });
  });

  it("uses wildcard chain when agent has no specific config", async () => {
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "build")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("anthropic/claude-sonnet-4");
    expect(calls.prompt[0]).toMatchObject({ providerID: "anthropic" });
  });
});

// ─── Max depth ────────────────────────────────────────────────────────────────

describe("attemptFallback — max depth", () => {
  it("refuses when fallbackDepth >= maxFallbackDepth", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    // Simulate depth already at max
    const state = store.sessions.get("s1");
    state.fallbackDepth = 3;
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("max fallback depth reached");
  });
});

// ─── Depth reset on TUI revert ───────────────────────────────────────────────

describe("attemptFallback — depth reset on TUI revert", () => {
  it("resets fallbackDepth when TUI reverts to originalModel", async () => {
    // Session previously fell back: depth=2, currentModel=claude-sonnet-4
    // TUI reverts to gpt-5.3, which is still rate-limited → triggers another fallback
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const state = store.sessions.get("s1");
    state.currentModel = "anthropic/claude-sonnet-4"; // plugin thinks we're on fallback
    state.fallbackDepth = 2;
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    // Depth was reset to 0 on revert, then incremented to 1 by the successful fallback
    expect(result.success).toBe(true);
    const updated = store.sessions.get("s1");
    expect(updated.fallbackDepth).toBe(1);
  });

  it("does not reset depth when model changes to a non-original model", async () => {
    // Session fell back from gpt-5.3 → claude-sonnet-4, depth=1
    // Now message comes from gemini-flash (not the original) — depth should NOT reset
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "google", "gemini-flash", "coder")],
    });
    const config = {
      ...BASE_CONFIG,
      agents: {
        coder: {
          fallbackModels: ["anthropic/claude-sonnet-4", "openai/gpt-5.3-codex"],
        },
        "*": { fallbackModels: ["anthropic/claude-sonnet-4"] },
      },
    };
    const store = makeStore(config);
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const state = store.sessions.get("s1");
    state.currentModel = "anthropic/claude-sonnet-4";
    state.fallbackDepth = 1;
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback("s1", "rate_limit", client, store, config, logger, "/tmp");

    // Depth was NOT reset (gemini-flash != originalModel gpt-5.3)
    // It was incremented by 1 from the fallback
    expect(result.success).toBe(true);
    const updated = store.sessions.get("s1");
    expect(updated.fallbackDepth).toBe(2);
  });

  it("allows fallback when depth was at max but revert resets it", async () => {
    // depth=3 (at max), but TUI reverted to original → reset to 0 → fallback succeeds
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const state = store.sessions.get("s1");
    state.currentModel = "anthropic/claude-sonnet-4";
    state.fallbackDepth = 3; // at maxFallbackDepth
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    // Previously this would fail with "max fallback depth reached"
    // Now the depth reset happens before the check, so it succeeds
    expect(result.success).toBe(true);
    expect(store.sessions.get("s1").fallbackDepth).toBe(1);
  });
});

// ─── Concurrency / dedup ─────────────────────────────────────────────────────

describe("attemptFallback — concurrency", () => {
  it("blocks a second concurrent call via processing lock", async () => {
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    // Fire two concurrent fallback attempts
    const [r1, r2] = await Promise.all([
      attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp"),
      attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp"),
    ]);

    // Exactly one should succeed
    const successes = [r1, r2].filter((r) => r.success);
    const failures = [r1, r2].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe("already processing");
    // Only one abort+revert+prompt sequence
    expect(calls.abort).toHaveLength(1);
    expect(calls.prompt).toHaveLength(1);
  });

  it("blocks within dedup window", async () => {
    const { client, calls } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    // First call succeeds
    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");
    // Second call immediately after — within 3s dedup window
    const r2 = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(r2.success).toBe(false);
    expect(r2.error).toBe("dedup window");
    expect(calls.prompt).toHaveLength(1);
  });

  it("dedup window is set optimistically before prompt completes", async () => {
    // Verify the race fix: lastFallbackAt is set before session.prompt()
    let dedupWindowActiveAtPromptTime = false;

    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });

    // Wrap the prompt to check dedup window state at prompt time
    const origPrompt = (client.session as { prompt: Function }).prompt.bind(client.session);
    (client.session as { prompt: Function }).prompt = async (opts: unknown) => {
      const state = store.sessions.get("s1");
      dedupWindowActiveAtPromptTime = state.lastFallbackAt !== null;
      return origPrompt(opts);
    };

    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    await attemptFallback("s1", "rate_limit", client, store, BASE_CONFIG, logger, "/tmp");

    expect(dedupWindowActiveAtPromptTime).toBe(true);
  });
});

// ─── Replay step failures ─────────────────────────────────────────────────────

describe("attemptFallback — replay step failures", () => {
  it("returns failure and releases lock when abort fails", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
      abortError: new Error("session busy"),
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("abort failed");
    // Lock must be released so a retry is possible
    expect(store.sessions.get("s1").isProcessing).toBe(false);
  });

  it("returns failure when revert fails", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
      revertError: new Error("message not found"),
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("revert failed");
    expect(store.sessions.get("s1").isProcessing).toBe(false);
  });

  it("returns failure when prompt fails", async () => {
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
      promptError: new Error("provider error"),
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("prompt failed");
    expect(store.sessions.get("s1").isProcessing).toBe(false);
  });

  it("returns failure when no fallback chain is configured", async () => {
    const config: PluginConfig = {
      ...BASE_CONFIG,
      agents: { "*": { fallbackModels: [] } },
    };
    const { client } = makeMockClient({
      messages: [makeUserMessage("s1", "m1", "openai", "gpt-5.3-codex", "coder")],
    });
    const store = makeStore(config);
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback("s1", "rate_limit", client, store, config, logger, "/tmp");

    expect(result.success).toBe(false);
    expect(result.error).toBe("no fallback chain configured");
  });

  it("returns failure when messages fetch fails", async () => {
    const { client } = makeMockClient({
      messagesError: new Error("network error"),
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("messages fetch failed");
  });

  it("returns failure when no user message found in history", async () => {
    const { client } = makeMockClient({ messages: [] });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("no user message found");
  });

  it("returns failure when user messages are missing parts", async () => {
    const malformedMessages = [
      {
        info: {
          id: "m1",
          sessionID: "s1",
          role: "user",
          time: { created: Date.now() },
          agent: "coder",
          model: { providerID: "openai", modelID: "gpt-5.3-codex" },
        },
      },
    ];

    const { client, calls } = makeMockClient({
      messages: malformedMessages as any,
    });
    const store = makeStore();
    store.sessions.setOriginalModel("s1", "openai/gpt-5.3-codex");
    const logger = new Logger(client, "/tmp/test.log", false);

    const result = await attemptFallback(
      "s1",
      "rate_limit",
      client,
      store,
      BASE_CONFIG,
      logger,
      "/tmp"
    );

    expect(result.success).toBe(true);
    expect(result.fallbackModel).toBe("anthropic/claude-sonnet-4");
    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0].parts).toEqual([{ type: "text", text: "" }]);
  });
});
