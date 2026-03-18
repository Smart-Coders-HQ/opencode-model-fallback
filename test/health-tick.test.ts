import { afterEach, describe, expect, it } from "bun:test";
import { ModelHealthStore } from "../src/state/model-health.js";
import type { HealthState, ModelKey } from "../src/types.js";

const stores: ModelHealthStore[] = [];

function makeStore(opts?: {
  onTransition?: (modelKey: ModelKey, from: HealthState, to: HealthState) => void;
}) {
  const store = new ModelHealthStore(opts);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.destroy();
  stores.length = 0;
});

describe("ModelHealthStore.tick() recovery transitions", () => {
  it("transitions rate_limited → cooldown when cooldownMs expires", async () => {
    const store = makeStore();

    // Mark rate_limited with 1ms cooldown
    store.markRateLimited("a/1", 1, 1000);
    expect(store.get("a/1").state).toBe("rate_limited");

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 5));

    // Call tick() to process state transitions
    (store as any).tick();

    // Should now be in cooldown state
    expect(store.get("a/1").state).toBe("cooldown");
  });

  it("transitions cooldown → healthy when retryOriginalAfterMs expires", async () => {
    const store = makeStore();

    // Mark rate_limited with 1ms cooldown and 2ms retry
    store.markRateLimited("a/1", 1, 2);
    expect(store.get("a/1").state).toBe("rate_limited");

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 5));

    // First tick: rate_limited → cooldown
    (store as any).tick();
    expect(store.get("a/1").state).toBe("cooldown");

    // Wait for retry to expire
    await new Promise((r) => setTimeout(r, 5));

    // Second tick: cooldown → healthy
    (store as any).tick();
    expect(store.get("a/1").state).toBe("healthy");
  });

  it("completes full cycle: healthy → rate_limited → cooldown → healthy", async () => {
    const store = makeStore();

    // Start healthy
    expect(store.get("a/1").state).toBe("healthy");

    // Mark rate_limited
    store.markRateLimited("a/1", 1, 2);
    expect(store.get("a/1").state).toBe("rate_limited");

    // Wait and tick to cooldown
    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick();
    expect(store.get("a/1").state).toBe("cooldown");

    // Wait and tick to healthy
    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick();
    expect(store.get("a/1").state).toBe("healthy");
  });

  it("fires onTransition callback with correct arguments for rate_limited → cooldown", async () => {
    const transitions: Array<{
      modelKey: ModelKey;
      from: HealthState;
      to: HealthState;
    }> = [];

    const store = makeStore({
      onTransition: (modelKey, from, to) => {
        transitions.push({ modelKey, from, to });
      },
    });

    store.markRateLimited("a/1", 1, 1000);
    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick();

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toEqual({
      modelKey: "a/1",
      from: "rate_limited",
      to: "cooldown",
    });
  });

  it("fires onTransition callback with correct arguments for cooldown → healthy", async () => {
    const transitions: Array<{
      modelKey: ModelKey;
      from: HealthState;
      to: HealthState;
    }> = [];

    const store = makeStore({
      onTransition: (modelKey, from, to) => {
        transitions.push({ modelKey, from, to });
      },
    });

    store.markRateLimited("a/1", 1, 2);
    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick(); // rate_limited → cooldown
    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick(); // cooldown → healthy

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toEqual({
      modelKey: "a/1",
      from: "rate_limited",
      to: "cooldown",
    });
    expect(transitions[1]).toEqual({
      modelKey: "a/1",
      from: "cooldown",
      to: "healthy",
    });
  });

  it("does not transition when cooldown has not expired", async () => {
    const store = makeStore();

    // Mark rate_limited with 10 second cooldown
    store.markRateLimited("a/1", 10_000, 20_000);
    expect(store.get("a/1").state).toBe("rate_limited");

    // Tick immediately (cooldown not expired)
    (store as any).tick();

    // Should still be rate_limited
    expect(store.get("a/1").state).toBe("rate_limited");
  });

  it("does not transition from cooldown when retry has not expired", async () => {
    const store = makeStore();

    // Mark rate_limited with 1ms cooldown, 10s retry
    store.markRateLimited("a/1", 1, 10_000);
    await new Promise((r) => setTimeout(r, 5));

    // First tick: rate_limited → cooldown
    (store as any).tick();
    expect(store.get("a/1").state).toBe("cooldown");

    // Second tick immediately (retry not expired)
    (store as any).tick();

    // Should still be cooldown
    expect(store.get("a/1").state).toBe("cooldown");
  });

  it("handles multiple models transitioning in the same tick", async () => {
    const transitions: Array<{
      modelKey: ModelKey;
      from: HealthState;
      to: HealthState;
    }> = [];

    const store = makeStore({
      onTransition: (modelKey, from, to) => {
        transitions.push({ modelKey, from, to });
      },
    });

    // Mark multiple models as rate_limited
    store.markRateLimited("a/1", 1, 1000);
    store.markRateLimited("b/2", 1, 1000);
    store.markRateLimited("c/3", 1, 1000);

    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick();

    // All three should transition
    expect(transitions).toHaveLength(3);
    expect(store.get("a/1").state).toBe("cooldown");
    expect(store.get("b/2").state).toBe("cooldown");
    expect(store.get("c/3").state).toBe("cooldown");
  });

  it("clears cooldownExpiresAt and retryOriginalAt when transitioning to healthy", async () => {
    const store = makeStore();

    store.markRateLimited("a/1", 1, 2);
    const afterMark = store.get("a/1");
    expect(afterMark.cooldownExpiresAt).not.toBeNull();
    expect(afterMark.retryOriginalAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick(); // → cooldown

    const afterCooldown = store.get("a/1");
    expect(afterCooldown.cooldownExpiresAt).not.toBeNull();
    expect(afterCooldown.retryOriginalAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    (store as any).tick(); // → healthy

    const afterHealthy = store.get("a/1");
    expect(afterHealthy.state).toBe("healthy");
    expect(afterHealthy.cooldownExpiresAt).toBeNull();
    expect(afterHealthy.retryOriginalAt).toBeNull();
  });
});
