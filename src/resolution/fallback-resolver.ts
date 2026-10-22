import type { ModelHealthStore } from "../state/model-health.js";
import type { ModelKey } from "../types.js";

/**
 * Walk the fallback chain and return the best available model.
 * Strategy:
 *   1. First model that is "healthy"
 *   2. First model that is "cooldown" (better than nothing)
 *   3. null if all are "rate_limited" or quarantined
 *
 * Always skips the current model and any model that is not usable
 * (rate_limited or quarantined).
 */
export function resolveFallbackModel(
  chain: ModelKey[],
  currentModel: ModelKey | null,
  health: ModelHealthStore
): ModelKey | null {
  const candidates = chain.filter((m) => m !== currentModel && health.isUsable(m));

  // Prefer healthy, then cooldown
  const healthy = candidates.find((m) => health.get(m).state === "healthy");
  if (healthy) return healthy;

  const cooldown = candidates.find((m) => health.get(m).state === "cooldown");
  if (cooldown) return cooldown;

  return null;
}
