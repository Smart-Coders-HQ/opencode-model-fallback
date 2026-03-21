import { describe, expect, it } from "bun:test";
import { ModelHealthStore } from "../src/state/model-health.js";

describe("ModelHealthStore lifecycle", () => {
  it("unrefs the transition timer so it does not keep the process alive", () => {
    const store = new ModelHealthStore();

    const timer = (store as unknown as { timer?: { hasRef?: () => boolean } }).timer;
    expect(timer).not.toBeNull();
    if (timer && typeof timer.hasRef === "function") {
      expect(timer.hasRef()).toBe(false);
    }

    store.destroy();
  });

  it("destroy is idempotent", () => {
    const store = new ModelHealthStore();

    store.destroy();
    store.destroy();

    const timer = (store as unknown as { timer?: unknown }).timer;
    expect(timer).toBeNull();
  });
});
