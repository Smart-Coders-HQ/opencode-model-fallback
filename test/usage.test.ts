import { describe, expect, it } from "bun:test";
import { getFallbackUsage } from "../src/display/usage.js";
import type { SessionFallbackState } from "../src/types.js";
import { makeMockClient } from "./helpers/mock-client.js";

function baseState(): SessionFallbackState {
  return {
    sessionId: "s1",
    agentName: "coder",
    agentFile: null,
    originalModel: "openai/gpt-5.3-codex",
    currentModel: "openai/gpt-5.3-codex",
    fallbackDepth: 0,
    isProcessing: false,
    lockedAt: null,
    lastFallbackAt: null,
    fallbackHistory: [],
    recoveryNotifiedForModel: null,
    fallbackActiveNotifiedKey: null,
  };
}

describe("getFallbackUsage", () => {
  it("counts assistant usage only and defaults missing tokens/cost to zero", async () => {
    const { client } = makeMockClient({
      messages: [
        {
          info: {
            role: "user",
            time: { created: 100 },
            tokens: { input: 99, output: 99 },
            cost: 9,
          },
          parts: [],
        },
        {
          info: {
            role: "assistant",
            time: { created: 101 },
            tokens: { input: 10, output: 20 },
            cost: 0.5,
          },
          parts: [],
        },
        {
          info: {
            role: "assistant",
            time: { created: 102 },
          },
          parts: [],
        },
      ] as any,
    });

    const usage = await getFallbackUsage(client, baseState());

    expect(usage.totalInputTokens).toBe(10);
    expect(usage.totalOutputTokens).toBe(20);
    expect(usage.totalCost).toBe(0.5);
  });

  it("builds fallback periods with from-inclusive and to-exclusive bounds", async () => {
    const { client } = makeMockClient({
      messages: [
        {
          info: {
            role: "assistant",
            time: { created: 100 },
            tokens: { input: 1, output: 2 },
            cost: 0.1,
          },
          parts: [],
        },
        {
          info: {
            role: "assistant",
            time: { created: 200 },
            tokens: { input: 3, output: 4 },
            cost: 0.2,
          },
          parts: [],
        },
        {
          info: {
            role: "assistant",
            time: { created: 300 },
            tokens: { input: 5, output: 6 },
            cost: 0.3,
          },
          parts: [],
        },
      ] as any,
    });

    const state = baseState();
    state.fallbackHistory = [
      {
        at: 100,
        fromModel: "openai/gpt-5.3-codex",
        toModel: "anthropic/claude-sonnet-4",
        reason: "rate_limit",
        sessionId: "s1",
        trigger: "reactive",
        agentName: "coder",
      },
      {
        at: 300,
        fromModel: "anthropic/claude-sonnet-4",
        toModel: "google/gemini-flash",
        reason: "rate_limit",
        sessionId: "s1",
        trigger: "reactive",
        agentName: "coder",
      },
    ];

    const usage = await getFallbackUsage(client, state);

    expect(usage.fallbackPeriods).toHaveLength(2);
    expect(usage.fallbackPeriods[0]).toMatchObject({
      model: "anthropic/claude-sonnet-4",
      from: 100,
      to: 300,
      inputTokens: 4,
      outputTokens: 6,
    });
    expect(usage.fallbackPeriods[0]?.cost ?? 0).toBeCloseTo(0.3, 10);
    expect(usage.fallbackPeriods[1]).toMatchObject({
      model: "google/gemini-flash",
      from: 300,
      to: null,
      inputTokens: 5,
      outputTokens: 6,
    });
    expect(usage.fallbackPeriods[1]?.cost ?? 0).toBeCloseTo(0.3, 10);
  });

  it("returns an empty summary when message fetch fails", async () => {
    const { client } = makeMockClient({ messagesError: new Error("network") });

    const usage = await getFallbackUsage(client, baseState());

    expect(usage.totalInputTokens).toBe(0);
    expect(usage.totalOutputTokens).toBe(0);
    expect(usage.totalCost).toBe(0);
    expect(usage.fallbackPeriods).toHaveLength(0);
  });
});
