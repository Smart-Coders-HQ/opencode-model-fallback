import type { HealthState, ModelHealth, ModelKey } from "../types.js";

export class ModelHealthStore {
  private store = new Map<ModelKey, ModelHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTransition?: (modelKey: ModelKey, from: HealthState, to: HealthState) => void;

  constructor(opts?: {
    onTransition?: (modelKey: ModelKey, from: HealthState, to: HealthState) => void
  }) {
    this.onTransition = opts?.onTransition;
    // Check state transitions every 30 seconds.
    // unref() prevents this timer from keeping the process alive if the host shuts down.
    this.timer = setInterval(() => this.tick(), 30_000).unref();
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

  quarantine(modelKey: ModelKey, ms: number): void {
    if (ms <= 0) return;
    const existing = this.get(modelKey);
    this.store.set(modelKey, {
      ...existing,
      quarantinedUntil: Date.now() + ms,
    });
  }

  isQuarantined(modelKey: ModelKey): boolean {
    const until = this.get(modelKey).quarantinedUntil;
    return until !== null && Date.now() < until;
  }

  isUsable(modelKey: ModelKey): boolean {
    if (this.isQuarantined(modelKey)) return false;
    const h = this.get(modelKey);
    return h.state === "healthy" || h.state === "cooldown";
  }

  preferScore(modelKey: ModelKey): number {
    if (this.isQuarantined(modelKey)) return 0;
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
      let current = health;
      if (current.quarantinedUntil !== null && now >= current.quarantinedUntil) {
        current = { ...current, quarantinedUntil: null };
        this.store.set(key, current);
      }

      if (
        current.state === "rate_limited" &&
        current.cooldownExpiresAt &&
        now >= current.cooldownExpiresAt
      ) {
        const next: ModelHealth = { ...current, state: "cooldown" };
        this.store.set(key, next);
        this.onTransition?.(key, "rate_limited", "cooldown");
      } else if (
        current.state === "cooldown" &&
        current.retryOriginalAt &&
        now >= current.retryOriginalAt
      ) {
        const next: ModelHealth = {
          ...current,
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
      quarantinedUntil: null,
    };
  }
}