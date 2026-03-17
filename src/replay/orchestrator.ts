import type { PluginInput } from "@opencode-ai/plugin";
import type { Part, UserMessage } from "@opencode-ai/sdk";
import type { ModelKey, ErrorCategory, PluginConfig } from "../types.js";
import type { FallbackStore } from "../state/store.js";
import type { Logger } from "../logging/logger.js";
import { resolveAgentName, resolveFallbackModels } from "../resolution/agent-resolver.js";
import { resolveFallbackModel } from "../resolution/fallback-resolver.js";
import { convertPartsForPrompt } from "./message-converter.js";

type Client = PluginInput["client"];

export interface ReplayResult {
  success: boolean;
  fallbackModel?: ModelKey;
  error?: string;
}

export async function attemptFallback(
  sessionId: string,
  reason: ErrorCategory,
  client: Client,
  store: FallbackStore,
  config: PluginConfig,
  logger: Logger
): Promise<ReplayResult> {
  const sessionState = store.sessions.get(sessionId);

  // Acquire per-session processing lock
  if (!store.sessions.acquireLock(sessionId)) {
    logger.debug("fallback.skipped.locked", { sessionId });
    return { success: false, error: "already processing" };
  }

  try {
    // Deduplication window
    if (store.sessions.isInDedupWindow(sessionId)) {
      logger.debug("fallback.skipped.dedup", { sessionId });
      return { success: false, error: "dedup window" };
    }

    // Check max fallback depth
    if (sessionState.fallbackDepth >= config.defaults.maxFallbackDepth) {
      logger.warn("fallback.exhausted", {
        sessionId,
        depth: sessionState.fallbackDepth,
        max: config.defaults.maxFallbackDepth,
      });
      return { success: false, error: "max fallback depth reached" };
    }

    // Resolve agent name (lazily)
    const agentName = await resolveAgentName(
      client,
      sessionId,
      sessionState.agentName
    );
    if (agentName) store.sessions.setAgentName(sessionId, agentName);

    // Resolve fallback chain for this agent
    const chain = resolveFallbackModels(config, agentName);
    if (chain.length === 0) {
      logger.warn("fallback.no-chain", { sessionId, agentName });
      return { success: false, error: "no fallback chain configured" };
    }

    // Pick next healthy model
    const fallbackModel = resolveFallbackModel(
      chain,
      sessionState.currentModel,
      store.health
    );
    if (!fallbackModel) {
      logger.warn("fallback.all-exhausted", { sessionId, chain });
      return { success: false, error: "all fallback models exhausted" };
    }

    // Mark current model as rate limited
    const currentModel = sessionState.currentModel;
    if (currentModel) {
      store.health.markRateLimited(
        currentModel,
        config.defaults.cooldownMs,
        config.defaults.retryOriginalAfterMs
      );
    }

    // Set lastFallbackAt optimistically NOW — before the async sequence —
    // so any stale retry events that fire during abort/revert/prompt are
    // caught by the dedup window. (recordFallback sets it again on success.)
    sessionState.lastFallbackAt = Date.now();

    // --- abort → revert → prompt sequence ---

    // Step 1: Abort retry loop
    try {
      await client.session.abort({ path: { id: sessionId } });
      logger.debug("replay.abort.ok", { sessionId });
    } catch (err) {
      logger.error("replay.abort.failed", { sessionId, err: String(err) });
      return { success: false, error: "abort failed" };
    }

    // Step 2: Fetch messages with parts
    let messagesWithParts: Array<{ info: { role: string; id: string; agent?: string }; parts: Part[] }>;
    try {
      const result = await client.session.messages({ path: { id: sessionId } });
      messagesWithParts = (result.data ?? []) as typeof messagesWithParts;
    } catch (err) {
      logger.error("replay.messages.failed", { sessionId, err: String(err) });
      return { success: false, error: "messages fetch failed" };
    }

    // Find last user message
    let lastUserEntry: { info: UserMessage; parts: Part[] } | null = null;
    for (let i = messagesWithParts.length - 1; i >= 0; i--) {
      const entry = messagesWithParts[i];
      if (entry.info.role === "user") {
        lastUserEntry = entry as { info: UserMessage; parts: Part[] };
        break;
      }
    }

    if (!lastUserEntry) {
      logger.warn("replay.no-user-message", { sessionId });
      return { success: false, error: "no user message found" };
    }

    // omf-owh.4: Always sync currentModel from the latest user message.
    // If the user manually switched models via the UI, sessionState.currentModel
    // would be stale. Reading it fresh here ensures we mark the right model as
    // rate_limited and fall back from the correct baseline.
    const msgModel = lastUserEntry.info.model;
    if (msgModel) {
      const modelKey: ModelKey = `${msgModel.providerID}/${msgModel.modelID}`;
      store.sessions.setOriginalModel(sessionId, modelKey);
      // Update currentModel to reflect whatever model is actually in use now
      const state = store.sessions.get(sessionId);
      if (state.currentModel !== modelKey && state.fallbackDepth === 0) {
        // Only reset if we haven't already fallen back — a non-zero depth means
        // we intentionally switched to a fallback model, not a manual switch.
        state.currentModel = modelKey;
        logger.debug("session.model.synced", { sessionId, modelKey });
      }
    }

    // Step 3: Revert to before the failed message
    try {
      await client.session.revert({
        path: { id: sessionId },
        body: { messageID: lastUserEntry.info.id },
      });
      logger.debug("replay.revert.ok", { sessionId, messageID: lastUserEntry.info.id });
    } catch (err) {
      logger.error("replay.revert.failed", { sessionId, err: String(err) });
      return { success: false, error: "revert failed" };
    }

    // Step 4: Re-prompt with fallback model
    const promptParts = convertPartsForPrompt(lastUserEntry.parts);
    if (promptParts.length === 0) {
      promptParts.push({ type: "text", text: "" });
    }

    const [providerID, ...rest] = fallbackModel.split("/");
    const modelID = rest.join("/");

    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          parts: promptParts as NonNullable<Parameters<typeof client.session.prompt>[0]["body"]>["parts"],
        },
      });
      logger.debug("replay.prompt.ok", { sessionId, fallbackModel });
    } catch (err) {
      logger.error("replay.prompt.failed", { sessionId, fallbackModel, err: String(err) });
      return { success: false, error: "prompt failed" };
    }

    // Record the successful fallback
    store.sessions.recordFallback(
      sessionId,
      currentModel ?? fallbackModel,
      fallbackModel,
      reason,
      agentName
    );

    logger.info("fallback.success", {
      sessionId,
      from: currentModel,
      to: fallbackModel,
      reason,
      depth: sessionState.fallbackDepth + 1,
    });

    return { success: true, fallbackModel };
  } finally {
    store.sessions.releaseLock(sessionId);
  }
}
