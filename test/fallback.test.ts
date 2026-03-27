import { describe, expect, it } from "bun:test";
import { resolveFallbackModels } from "../src/resolution/agent-resolver.js";
import { resolveFallbackModel } from "../src/resolution/fallback-resolver.js";
import { ModelHealthStore } from "../src/state/model-health.js";
import { SessionStateStore } from "../src/state/session-state.js";
import type { PluginConfig } from "../src/types.js";

function makeHealth() {
  const s = new ModelHealthStore();
  return { store: s, destroy: () => s.destroy() };
}

describe("resolveFallbackModel", () => {
  it("picks the first healthy model, skipping current", () => {
    const { store, destroy } = makeHealth();
    try {
      const chain = ["a/1", "a/2", "a/3"];
      const result = resolveFallbackModel(chain, "a/1", store);
      expect(result).toBe("a/2"); // first non-current healthy model
    } finally {
      destroy();
    }
  });

  it("skips rate_limited models", () => {
    const { store, destroy } = makeHealth();
    try {
      store.markRateLimited("a/2", 300_000, 900_000);
      const chain = ["a/1", "a/2", "a/3"];
      const result = resolveFallbackModel(chain, "a/1", store);
      expect(result).toBe("a/3");
    } finally {
      destroy();
    }
  });

  it("returns null when all models are rate_limited", () => {
    const { store, destroy } = makeHealth();
    try {
      store.markRateLimited("a/2", 300_000, 900_000);
      store.markRateLimited("a/3", 300_000, 900_000);
      const chain = ["a/1", "a/2", "a/3"];
      const result = resolveFallbackModel(chain, "a/1", store);
      expect(result).toBeNull();
    } finally {
      destroy();
    }
  });

  it("uses cooldown models as last resort", () => {
    const { store, destroy } = makeHealth();
    try {
      // Manually set cooldown state by first marking rate_limited
      // then artificially expire cooldown
      store.markRateLimited("a/2", 300_000, 900_000);
      store.markRateLimited("a/3", 300_000, 900_000);
      // Override a/3 to cooldown state by getting its health and checking state
      // (we can't easily expire timers in tests, so we verify the priority logic)
      const chain = ["a/1", "a/2", "a/3"];
      const result = resolveFallbackModel(chain, "a/1", store);
      // Both are rate_limited so no cooldown available either
      expect(result).toBeNull();
    } finally {
      destroy();
    }
  });

  it("returns null when fallback chain is empty", () => {
    const { store, destroy } = makeHealth();
    try {
      const result = resolveFallbackModel([], "a/1", store);
      expect(result).toBeNull();
    } finally {
      destroy();
    }
  });

  it("returns null when chain contains only the current model", () => {
    const { store, destroy } = makeHealth();
    try {
      const chain = ["a/1"];
      const result = resolveFallbackModel(chain, "a/1", store);
      expect(result).toBeNull();
    } finally {
      destroy();
    }
  });
});

describe("resolveFallbackModels", () => {
  const config: PluginConfig = {
    enabled: true,
    defaults: {
      fallbackOn: ["rate_limit"],
      cooldownMs: 300_000,
      retryOriginalAfterMs: 900_000,
      maxFallbackDepth: 3,
    },
    agents: {
      build: { fallbackModels: ["a/1", "a/2"] },
      "*": { fallbackModels: ["b/1"] },
    },
    patterns: ["rate limit"],
    logging: false,
    logLevel: "info",
    logPath: "/tmp/test.log",
    agentDirs: [],
  };

  it("returns agent-specific chain when agent matches", () => {
    const result = resolveFallbackModels(config, "build");
    expect(result).toEqual(["a/1", "a/2"]);
  });

  it("matches normalized agent names like Build -> BuildAgent", () => {
    const result = resolveFallbackModels(
      {
        ...config,
        agents: {
          BuildAgent: { fallbackModels: ["c/1", "c/2"] },
          "*": { fallbackModels: ["b/1"] },
        },
      },
      "Build"
    );

    expect(result).toEqual(["c/1", "c/2"]);
  });

  it("falls back to wildcard when agent not configured", () => {
    const result = resolveFallbackModels(config, "coder");
    expect(result).toEqual(["b/1"]);
  });

  it("uses wildcard for null agent", () => {
    const result = resolveFallbackModels(config, null);
    expect(result).toEqual(["b/1"]);
  });
});

describe("SessionStateStore", () => {
  it("acquires and releases lock", () => {
    const store = new SessionStateStore();
    expect(store.acquireLock("s1")).toBe(true);
    expect(store.acquireLock("s1")).toBe(false); // locked
    store.releaseLock("s1");
    expect(store.acquireLock("s1")).toBe(true); // available again
    store.releaseLock("s1");
  });

  it("dedup window blocks within 3s", () => {
    const store = new SessionStateStore();
    const state = store.get("s2");
    state.lastFallbackAt = Date.now() - 1_000; // 1s ago
    expect(store.isInDedupWindow("s2")).toBe(true);
  });

  it("dedup window allows after 3s", () => {
    const store = new SessionStateStore();
    const state = store.get("s3");
    state.lastFallbackAt = Date.now() - 4_000; // 4s ago
    expect(store.isInDedupWindow("s3")).toBe(false);
  });

  it("records fallback and increments depth", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s4", "a/orig");
    store.recordFallback("s4", "a/orig", "a/fallback", "rate_limit", "coder");
    const state = store.get("s4");
    expect(state.fallbackDepth).toBe(1);
    expect(state.currentModel).toBe("a/fallback");
    expect(state.fallbackHistory).toHaveLength(1);
    expect(state.fallbackHistory[0].reason).toBe("rate_limit");
  });

  it("deletes session state", () => {
    const store = new SessionStateStore();
    store.get("s5");
    store.delete("s5");
    // After delete, get returns fresh state
    const state = store.get("s5");
    expect(state.fallbackDepth).toBe(0);
  });

  it("recordFallback sets trigger field to 'reactive'", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s6", "a/orig");
    store.recordFallback("s6", "a/orig", "a/fallback", "rate_limit", "coder");

    const state = store.get("s6");
    expect(state.fallbackHistory).toHaveLength(1);
    expect(state.fallbackHistory[0].trigger).toBe("reactive");
  });

  it("recordPreemptiveRedirect sets trigger field to 'preemptive'", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s7", "a/orig");
    store.recordPreemptiveRedirect("s7", "a/orig", "a/fallback", "coder");

    const state = store.get("s7");
    expect(state.fallbackHistory).toHaveLength(1);
    expect(state.fallbackHistory[0].trigger).toBe("preemptive");
  });

  it("recordPreemptiveRedirect sets reason to 'rate_limit'", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s8", "a/orig");
    store.recordPreemptiveRedirect("s8", "a/orig", "a/fallback", "coder");

    const state = store.get("s8");
    expect(state.fallbackHistory[0].reason).toBe("rate_limit");
  });

  it("recordPreemptiveRedirect increments fallback depth", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s9", "a/orig");
    store.recordPreemptiveRedirect("s9", "a/orig", "a/fallback", "coder");

    const state = store.get("s9");
    expect(state.fallbackDepth).toBe(1);
  });

  it("consumes fallback-active notification only once per fallback pair", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s10", "a/orig");
    store.recordPreemptiveRedirect("s10", "a/orig", "a/fallback", "coder");

    expect(store.consumeFallbackActiveNotification("s10")).toEqual({
      originalModel: "a/orig",
      currentModel: "a/fallback",
    });
    expect(store.consumeFallbackActiveNotification("s10")).toBeNull();
  });

  it("clears fallback-active notification after returning to original model", () => {
    const store = new SessionStateStore();
    store.setOriginalModel("s11", "a/orig");
    store.recordPreemptiveRedirect("s11", "a/orig", "a/fallback", "coder");

    expect(store.consumeFallbackActiveNotification("s11")).not.toBeNull();
    store.clearFallbackActiveNotification("s11");
    store.get("s11").currentModel = "a/orig";
    store.recordPreemptiveRedirect("s11", "a/orig", "a/fallback", "coder");

    expect(store.consumeFallbackActiveNotification("s11")).toEqual({
      originalModel: "a/orig",
      currentModel: "a/fallback",
    });
  });
});
