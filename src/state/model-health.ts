import type { ModelHealth, ModelKey, HealthState } from "../types.js";

export class ModelHealthStore {
  private store = new Map<ModelKey, ModelHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTransition?: (modelKey: ModelKey, from: HealthState, to: HealthState) => void;

  constructor(opts?: {
    onTransition?: (modelKey: ModelKey, from: HealthState, to: HealthState) => void;
  }) {
    this.onTransition = opts?.onTransition;
    // Check state transitions every 30 seconds
    this.timer = setInterval(() => this.tick(), 30_000);
  }

  get(modelKey: ModelKey): ModelHealth {
    return this.store.get(modelKey) ?? this.newHealth(modelKey);
  }

  markRateLimited(modelKey: ModelKey, cooldownMs: number, retryOriginalAfterMs: number): void {
    const now = Date.now();
    const existing = this.get(modelKey);
    const health: ModelHealth = {
      ...existing,
      state: "rate_limited",
      lastFailure: now,
      failureCount: existing.failureCount + 1,
      cooldownExpiresAt: now + cooldownMs,
      retryOriginalAt: now + retryOriginalAfterMs,
    };
    this.store.set(modelKey, health);
  }

  isUsable(modelKey: ModelKey): boolean {
    const h = this.get(modelKey);
    return h.state === "healthy" || h.state === "cooldown";
  }

  preferScore(modelKey: ModelKey): number {
    // healthy=2, cooldown=1, rate_limited=0
    const state = this.get(modelKey).state;
    if (state === "healthy") return 2;
    if (state === "cooldown") return 1;
    return 0;
  }

  getAll(): ModelHealth[] {
    return Array.from(this.store.values());
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const [key, health] of this.store) {
      if (
        health.state === "rate_limited" &&
        health.cooldownExpiresAt &&
        now >= health.cooldownExpiresAt
      ) {
        const next: ModelHealth = { ...health, state: "cooldown" };
        this.store.set(key, next);
        this.onTransition?.(key, "rate_limited", "cooldown");
      } else if (
        health.state === "cooldown" &&
        health.retryOriginalAt &&
        now >= health.retryOriginalAt
      ) {
        const next: ModelHealth = {
          ...health,
          state: "healthy",
          cooldownExpiresAt: null,
          retryOriginalAt: null,
        };
        this.store.set(key, next);
        this.onTransition?.(key, "cooldown", "healthy");
      }
    }
  }

  private newHealth(modelKey: ModelKey): ModelHealth {
    return {
      modelKey,
      state: "healthy",
      lastFailure: null,
      failureCount: 0,
      cooldownExpiresAt: null,
      retryOriginalAt: null,
    };
  }
}
