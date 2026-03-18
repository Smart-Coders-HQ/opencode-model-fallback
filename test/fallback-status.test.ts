import { afterEach, describe, expect, it } from "bun:test";
import { Logger } from "../src/logging/logger.js";
import { FallbackStore } from "../src/state/store.js";
import { createFallbackStatusTool } from "../src/tools/fallback-status.js";
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

describe("fallback-status tool", () => {
  it("renders output for partially seeded session state", async () => {
    const { client } = makeMockClient({ messages: [{} as any] });
    const store = makeStore();
    const sessionState = store.sessions.get("s1");

    sessionState.fallbackHistory.push({
      at: Date.now(),
      fromModel: "openai/gpt-5.3-codex",
      toModel: "anthropic/claude-sonnet-4",
      reason: "rate_limit",
      sessionId: "s1",
      trigger: "preemptive",
      agentName: null,
    });

    const tool = createFallbackStatusTool(store, BASE_CONFIG, client, "/tmp");
    const output = await tool.execute({ verbose: true }, {
      sessionID: "s1",
    } as Parameters<typeof tool.execute>[1]);

    expect(output).toContain("## Model Fallback Status");
    expect(output).toContain("### Current Session");
    expect(output).toContain("### Fallback History");
    expect(output).toContain("(rate_limit, preemptive)");
    expect(output).toContain("### Usage Summary");
  });
});
