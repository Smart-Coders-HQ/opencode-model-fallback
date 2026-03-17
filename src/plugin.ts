import type { Plugin, Hooks } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { loadConfig } from "./config/loader.js";
import { Logger } from "./logging/logger.js";
import { FallbackStore } from "./state/store.js";
import { matchesAnyPattern } from "./detection/patterns.js";
import { classifyError } from "./detection/classifier.js";
import { attemptFallback } from "./replay/orchestrator.js";
import { notifyFallback, notifyRecovery } from "./display/notifier.js";
import { createFallbackStatusTool } from "./tools/fallback-status.js";
import type { ErrorCategory, ModelKey } from "./types.js";

export const createPlugin: Plugin = async ({ client, directory }) => {
  const { config, path: configPath, warnings, migrated } = loadConfig(directory);

  const logger = new Logger(client, config.logPath, config.logging);

  logger.info("plugin.init", {
    configPath,
    enabled: config.enabled,
    migrated,
    agentCount: Object.keys(config.agents).length,
  });

  for (const w of warnings) {
    logger.warn("config.warning", { message: w });
  }

  if (migrated) {
    logger.info("config.migrated", {
      message: "Auto-migrated from old rate-limit-fallback.json format",
    });
  }

  if (!config.enabled) {
    logger.info("plugin.disabled");
    return {};
  }

  const store = new FallbackStore(config, logger);

  const hooks: Hooks = {
    async event({ event }) {
      await handleEvent(event, client, store, config, logger);
    },

    tool: {
      "fallback-status": createFallbackStatusTool(store, config, client),
    },
  };

  return hooks;
};

async function handleEvent(
  event: Event,
  client: Parameters<Plugin>[0]["client"],
  store: FallbackStore,
  config: ReturnType<typeof loadConfig>["config"],
  logger: Logger
): Promise<void> {
  if (event.type === "session.status") {
    const { sessionID, status } = event.properties;

    if (status.type === "retry") {
      await handleRetry(sessionID, status.message, client, store, config, logger);
    } else if (status.type === "idle") {
      await handleIdle(sessionID, client, store, config, logger);
    }
    return;
  }

  if (event.type === "session.error") {
    const { sessionID, error } = event.properties;
    if (!sessionID || !error) return;

    if (error.name === "APIError") {
      const category = classifyError(
        error.data.message,
        error.data.statusCode
      );
      if (config.defaults.fallbackOn.includes(category as ErrorCategory)) {
        const result = await attemptFallback(
          sessionID,
          category as ErrorCategory,
          client,
          store,
          config,
          logger
        );
        if (result.success && result.fallbackModel) {
          const state = store.sessions.get(sessionID);
          await notifyFallback(client, state.originalModel, result.fallbackModel, category as ErrorCategory);
        }
      }
    }
    return;
  }

  if (event.type === "session.deleted") {
    const sessionID = event.properties.info.id;
    store.sessions.delete(sessionID);
    return;
  }

  // omf-owh.3: Reset session fallback state on compaction — message IDs shift,
  // so any cached state (originalModel, fallbackHistory) is no longer reliable.
  if (event.type === "session.compacted") {
    const sessionID = event.properties.sessionID;
    store.sessions.delete(sessionID);
    logger.info("session.compacted.reset", { sessionID });
    return;
  }
}

async function handleRetry(
  sessionId: string,
  message: string,
  client: Parameters<Plugin>[0]["client"],
  store: FallbackStore,
  config: ReturnType<typeof loadConfig>["config"],
  logger: Logger
): Promise<void> {
  // Check if the retry message matches any fallback-triggering pattern
  if (!matchesAnyPattern(message, config.patterns)) {
    return;
  }

  const category = classifyError(message);
  if (!config.defaults.fallbackOn.includes(category as ErrorCategory)) {
    logger.debug("retry.ignored", { sessionId, message, category });
    return;
  }

  logger.info("retry.detected", { sessionId, message, category });

  // Seed session state with current model if unknown
  const sessionState = store.sessions.get(sessionId);
  if (!sessionState.currentModel) {
    try {
      const msgs = await client.session.messages({ path: { id: sessionId } });
      const entries = (msgs.data ?? []) as Array<{ info: { role: string; model?: { providerID: string; modelID: string }; agent?: string } }>;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.info.role === "user" && entry.info.model) {
          const key: ModelKey = `${entry.info.model.providerID}/${entry.info.model.modelID}`;
          store.sessions.setOriginalModel(sessionId, key);
          if (entry.info.agent) store.sessions.setAgentName(sessionId, entry.info.agent);
          break;
        }
      }
    } catch {
      // Best-effort
    }
  }

  const result = await attemptFallback(
    sessionId,
    category as ErrorCategory,
    client,
    store,
    config,
    logger
  );

  if (result.success && result.fallbackModel) {
    const state = store.sessions.get(sessionId);
    await notifyFallback(
      client,
      state.originalModel,
      result.fallbackModel,
      category as ErrorCategory
    );
  }
}

async function handleIdle(
  sessionId: string,
  client: Parameters<Plugin>[0]["client"],
  store: FallbackStore,
  config: ReturnType<typeof loadConfig>["config"],
  logger: Logger
): Promise<void> {
  const state = store.sessions.get(sessionId);
  if (!state.originalModel) return;
  if (state.currentModel === state.originalModel) return;

  // Check if original model has recovered
  const health = store.health.get(state.originalModel);
  if (health.state === "healthy") {
    logger.info("recovery.available", {
      sessionId,
      originalModel: state.originalModel,
    });
    await notifyRecovery(client, state.originalModel);
  }
}
