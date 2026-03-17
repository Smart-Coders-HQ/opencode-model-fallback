import { describe, it, expect, afterEach } from "bun:test";
import { ModelHealthStore } from "../src/state/model-health.js";

describe("ModelHealthStore", () => {
  const stores: ModelHealthStore[] = [];

  afterEach(() => {
    for (const s of stores) s.destroy();
    stores.length = 0;
  });

  function makeStore(onTransition?: Parameters<typeof ModelHealthStore>[0]["onTransition"]) {
    const s = new ModelHealthStore({ onTransition });
    stores.push(s);
    return s;
  }

  it("returns healthy state for unknown models", () => {
    const store = makeStore();
    const h = store.get("anthropic/claude-sonnet-4");
    expect(h.state).toBe("healthy");
    expect(h.failureCount).toBe(0);
  });

  it("marks model as rate_limited", () => {
    const store = makeStore();
    store.markRateLimited("anthropic/claude-sonnet-4", 300_000, 900_000);
    const h = store.get("anthropic/claude-sonnet-4");
    expect(h.state).toBe("rate_limited");
    expect(h.failureCount).toBe(1);
    expect(h.cooldownExpiresAt).toBeGreaterThan(Date.now());
  });

  it("increments failure count on repeated rate limits", () => {
    const store = makeStore();
    store.markRateLimited("m/a", 300_000, 900_000);
    store.markRateLimited("m/a", 300_000, 900_000);
    expect(store.get("m/a").failureCount).toBe(2);
  });

  it("isUsable returns false for rate_limited, true for healthy/cooldown", () => {
    const store = makeStore();
    store.markRateLimited("m/a", 300_000, 900_000);
    expect(store.isUsable("m/a")).toBe(false);
    expect(store.isUsable("m/b")).toBe(true); // healthy by default
  });

  it("preferScore: healthy=2 > cooldown=1 > rate_limited=0", () => {
    const store = makeStore();
    // healthy
    expect(store.preferScore("m/healthy")).toBe(2);
    // rate_limited
    store.markRateLimited("m/limited", 300_000, 900_000);
    expect(store.preferScore("m/limited")).toBe(0);
  });

  it("getAll returns all tracked models", () => {
    const store = makeStore();
    store.get("m/a");
    store.markRateLimited("m/b", 300_000, 900_000);
    const all = store.getAll();
    expect(all.map((h) => h.modelKey)).toContain("m/b");
  });
});
