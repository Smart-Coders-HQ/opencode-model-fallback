import type { ModelKey, PluginConfig } from "./types.js";
import type { FallbackStore } from "./state/store.js";
import type { Logger } from "./logging/logger.js";
import { resolveFallbackModels } from "./resolution/agent-resolver.js";
import { resolveFallbackModel } from "./resolution/fallback-resolver.js";

export interface PreemptiveResult {
  redirected: boolean;
  fallbackModel?: ModelKey;
}

/**
 * Check whether a message's target model is rate-limited and, if so,
 * resolve a healthy fallback model. Also syncs session state and resets
 * fallbackDepth when the TUI reverts to the original model.
 *
 * Pure synchronous logic — no API calls. Designed for the `chat.message` hook.
 */
export function tryPreemptiveRedirect(
  sessionId: string,
  modelKey: ModelKey,
  agentName: string | null,
  store: FallbackStore,
  config: PluginConfig,
  logger: Logger
): PreemptiveResult {
  const sessionState = store.sessions.get(sessionId);

  // Sync model state from the incoming message
  store.sessions.setOriginalModel(sessionId, modelKey);
  if (sessionState.currentModel !== modelKey) {
    const wasOnFallback =
      sessionState.currentModel !== null &&
      sessionState.currentModel !== sessionState.originalModel;
    sessionState.currentModel = modelKey;
    if (wasOnFallback && modelKey === sessionState.originalModel) {
      sessionState.fallbackDepth = 0;
      logger.debug("preemptive.depth.reset", { sessionId, modelKey });
    }
  }

  // Only redirect if the target model is actively rate-limited
  const health = store.health.get(modelKey);
  if (health.state !== "rate_limited") {
    return { redirected: false };
  }

  // Resolve fallback chain for this agent
  const chain = resolveFallbackModels(config, agentName);
  if (chain.length === 0) {
    logger.debug("preemptive.no-chain", { sessionId, agentName });
    return { redirected: false };
  }

  // Pick a healthy fallback
  const fallbackModel = resolveFallbackModel(chain, modelKey, store.health);
  if (!fallbackModel) {
    logger.debug("preemptive.all-exhausted", { sessionId });
    return { redirected: false };
  }

  logger.info("preemptive.redirect", {
    sessionId,
    agentName,
    agentFile: sessionState.agentFile,
    from: modelKey,
    to: fallbackModel,
  });

  store.sessions.recordPreemptiveRedirect(sessionId, modelKey, fallbackModel, agentName);

  return { redirected: true, fallbackModel };
}
