import { afterEach, describe, expect, it } from "bun:test";
import { ModelHealthStore } from "../src/state/model-health.js";

describe("ModelHealthStore", () => {
  const stores: ModelHealthStore[] = [];

  afterEach(() => {
    for (const s of stores) s.destroy();
    stores.length = 0;
  });

  type TransitionCb = ConstructorParameters<typeof ModelHealthStore>[0] extends
    | { onTransition?: infer F }
    | undefined
    ? F
    : never;

  function makeStore(onTransition?: TransitionCb) {
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

  // --- tick() recovery transitions ---

  it("tick transitions rate_limited → cooldown when cooldownExpiresAt has passed", () => {
    const transitions: Array<[string, string, string]> = [];
    const store = makeStore((key, from, to) => transitions.push([key, from, to]));

    store.markRateLimited("m/a", 1 /* 1ms */, 999_999);
    // Wait until the cooldown expires
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* busy-wait 5ms */
    }
    (store as unknown as { tick(): void }).tick();

    expect(store.get("m/a").state).toBe("cooldown");
    expect(transitions).toEqual([["m/a", "rate_limited", "cooldown"]]);
  });

  it("tick transitions cooldown → healthy when retryOriginalAt has passed", () => {
    const transitions: Array<[string, string, string]> = [];
    const store = makeStore((key, from, to) => transitions.push([key, from, to]));

    // Drive model through rate_limited → cooldown manually
    store.markRateLimited("m/b", 1, 1);
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* busy-wait 5ms */
    }
    (store as unknown as { tick(): void }).tick(); // → cooldown
    (store as unknown as { tick(): void }).tick(); // → healthy (retryOriginalAt also expired)

    expect(store.get("m/b").state).toBe("healthy");
    expect(transitions.map((t) => [t[1], t[2]])).toContainEqual(["cooldown", "healthy"]);
    expect(store.get("m/b").cooldownExpiresAt).toBeNull();
    expect(store.get("m/b").retryOriginalAt).toBeNull();
  });

  it("tick does not fire onTransition when model is healthy and nothing to do", () => {
    const transitions: Array<unknown> = [];
    const store = makeStore((key, from, to) => transitions.push([key, from, to]));
    store.get("m/c"); // seed a healthy entry
    (store as unknown as { tick(): void }).tick();
    expect(transitions).toHaveLength(0);
  });
});
