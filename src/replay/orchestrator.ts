import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { ModelKey, ErrorCategory, PluginConfig } from "../types.js";
import type { FallbackStore } from "../state/store.js";
import type { Logger } from "../logging/logger.js";
import { resolveAgentName, resolveFallbackModels } from "../resolution/agent-resolver.js";
import { resolveFallbackModel } from "../resolution/fallback-resolver.js";
import { convertPartsForPrompt } from "./message-converter.js";
import { resolveAgentFile, toRelativeAgentPath } from "../config/agent-loader.js";

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
  logger: Logger,
  directory: string
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

    // Resolve agent name (lazily)
    const agentName = await resolveAgentName(client, sessionId, sessionState.agentName);
    if (agentName) {
      store.sessions.setAgentName(sessionId, agentName);
      if (!sessionState.agentFile) {
        const absPath = resolveAgentFile(
          agentName,
          directory,
          config.agentDirs?.length ? config.agentDirs : undefined
        );
        if (absPath)
          store.sessions.setAgentFile(sessionId, toRelativeAgentPath(absPath, directory));
      }
    }

    // Resolve fallback chain for this agent
    const chain = resolveFallbackModels(config, agentName);
    if (chain.length === 0) {
      logger.warn("fallback.no-chain", { sessionId, agentName });
      return { success: false, error: "no fallback chain configured" };
    }

    // omf-owh.4: Fetch messages first to sync currentModel from the failing message.
    // The TUI may have reverted to the original model after a prior fallback, so
    // sessionState.currentModel can be stale. We must sync before resolving the
    // fallback model so the resolver filters out the *actual* failing model.
    let messageEntries: unknown[];
    try {
      const result = await client.session.messages({ path: { id: sessionId } });
      messageEntries = Array.isArray(result.data) ? result.data : [];
    } catch (err) {
      logger.error("replay.messages.failed", { sessionId, err: String(err) });
      return { success: false, error: "messages fetch failed" };
    }

    // Find last user message
    let lastUserEntry: {
      id: string;
      model?: { providerID: string; modelID: string };
      parts: Part[];
    } | null = null;

    for (let i = messageEntries.length - 1; i >= 0; i--) {
      const entry = messageEntries[i];
      if (!entry || typeof entry !== "object") continue;

      const info = (entry as { info?: unknown }).info;
      if (!info || typeof info !== "object") continue;

      const role = (info as { role?: unknown }).role;
      if (role !== "user") continue;

      const id = (info as { id?: unknown }).id;
      if (typeof id !== "string") continue;

      const rawParts = (entry as { parts?: unknown }).parts;
      const safeParts = sanitizeParts(rawParts);
      if (safeParts.length === 0 && Array.isArray(rawParts) && rawParts.length > 0) {
        continue;
      }

      const rawModel = (info as { model?: unknown }).model;
      let model: { providerID: string; modelID: string } | undefined;
      if (rawModel && typeof rawModel === "object") {
        const providerID = (rawModel as { providerID?: unknown }).providerID;
        const modelID = (rawModel as { modelID?: unknown }).modelID;
        if (typeof providerID === "string" && typeof modelID === "string") {
          model = { providerID, modelID };
        }
      }

      lastUserEntry = {
        id,
        model,
        parts: safeParts,
      };
      break;
    }

    if (!lastUserEntry) {
      logger.warn("replay.no-user-message", { sessionId });
      return { success: false, error: "no user message found" };
    }

    // Sync currentModel from the failing message so the resolver uses the right baseline.
    const msgModel = lastUserEntry.model;
    if (msgModel) {
      const modelKey: ModelKey = `${msgModel.providerID}/${msgModel.modelID}`;
      store.sessions.setOriginalModel(sessionId, modelKey);
      if (sessionState.currentModel !== modelKey) {
        const wasOnFallback =
          sessionState.currentModel !== null &&
          sessionState.currentModel !== sessionState.originalModel;
        sessionState.currentModel = modelKey;
        if (wasOnFallback && modelKey === sessionState.originalModel) {
          sessionState.fallbackDepth = 0;
          logger.debug("session.depth.reset", { sessionId, modelKey });
        }
        logger.debug("session.model.synced", { sessionId, modelKey });
      }
    }

    // Check max fallback depth (after sync so revert-reset takes effect)
    if (sessionState.fallbackDepth >= config.defaults.maxFallbackDepth) {
      logger.warn("fallback.exhausted", {
        sessionId,
        depth: sessionState.fallbackDepth,
        max: config.defaults.maxFallbackDepth,
      });
      return { success: false, error: "max fallback depth reached" };
    }

    // Pick next healthy model (uses synced currentModel)
    const fallbackModel = resolveFallbackModel(chain, sessionState.currentModel, store.health);
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

    // Step 2: Revert to before the failed message
    try {
      await client.session.revert({
        path: { id: sessionId },
        body: { messageID: lastUserEntry.id },
      });
      logger.debug("replay.revert.ok", {
        sessionId,
        messageID: lastUserEntry.id,
      });
    } catch (err) {
      logger.error("replay.revert.failed", { sessionId, err: String(err) });
      return { success: false, error: "revert failed" };
    }

    // Step 3: Re-prompt with fallback model
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
          parts: promptParts as NonNullable<
            Parameters<typeof client.session.prompt>[0]["body"]
          >["parts"],
        },
      });
      logger.debug("replay.prompt.ok", { sessionId, fallbackModel });
    } catch (err) {
      logger.error("replay.prompt.failed", {
        sessionId,
        fallbackModel,
        err: String(err),
      });
      return { success: false, error: "prompt failed" };
    }

    // Capture depth before recordFallback increments it
    const newDepth = sessionState.fallbackDepth + 1;

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
      agentName,
      agentFile: store.sessions.get(sessionId).agentFile,
      from: currentModel,
      to: fallbackModel,
      reason,
      depth: newDepth,
    });

    return { success: true, fallbackModel };
  } finally {
    store.sessions.releaseLock(sessionId);
  }
}

function sanitizeParts(parts: unknown): Part[] {
  if (!Array.isArray(parts)) return [];

  return parts.filter(
    (part): part is Part => typeof part === "object" && part !== null && "type" in part
  );
}
