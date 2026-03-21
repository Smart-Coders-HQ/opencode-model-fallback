import type { Hooks, Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { resolveAgentFile, toRelativeAgentPath } from "./config/agent-loader.js";
import { loadConfig } from "./config/loader.js";
import { classifyError } from "./detection/classifier.js";
import { matchesAnyPattern } from "./detection/patterns.js";
import { notifyFallback, notifyFallbackActive, notifyRecovery } from "./display/notifier.js";
import { Logger } from "./logging/logger.js";
import { tryPreemptiveRedirect } from "./preemptive.js";
import { attemptFallback } from "./replay/orchestrator.js";
import { FallbackStore } from "./state/store.js";
import { createFallbackStatusTool } from "./tools/fallback-status.js";
import type { ModelKey } from "./types.js";

function resolveFallbackStatusCommandPath(): string {
  return join(homedir(), ".config", "opencode", "commands", "fallback-status.md");
}

export function ensureFallbackStatusCommand(logger: Logger, cmdPath: string): void {
  try {
    mkdirSync(dirname(cmdPath), { recursive: true, mode: 0o700 });
    writeFileSync(cmdPath, "Call the fallback-status tool and display the full output.\n", {
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      logger.warn("fallback-status.command.write.failed", { cmdPath, err });
    }
  }
}

export const createPlugin: Plugin = async ({ client, directory }) => {
  const { config, path: configPath, warnings, migrated } = loadConfig(directory);

  const logger = new Logger(client, config.logPath, config.logging, config.logLevel);

  logger.info("plugin.init", {
    configPath,
    enabled: config.enabled,
    migrated,
    agentCount: Object.keys(config.agents).length,
  });

  for (const w of warnings) {
    logger.warn("config.warning", { warning: w });
  }

  if (migrated) {
    logger.info("config.migrated", {
      note: "Auto-migrated from old rate-limit-fallback.json format",
    });
  }

  if (!config.enabled) {
    logger.info("plugin.disabled");
    return {};
  }

  const cmdPath = resolveFallbackStatusCommandPath();
  ensureFallbackStatusCommand(logger, cmdPath);

  const store = new FallbackStore(config, logger);

  const hooks: Hooks = {
    async event({ event }) {
      await handleEvent(event, client, store, config, logger, directory);
    },

    "chat.message": async (input, output) => {
      if (!input.model) return;

      const modelKey: ModelKey = `${input.model.providerID}/${input.model.modelID}`;
      const sessionState = store.sessions.get(input.sessionID);

      if (input.agent) {
        store.sessions.setAgentName(input.sessionID, input.agent);
        if (!sessionState.agentFile) {
          const absPath = resolveAgentFile(
            input.agent,
            directory,
            config.agentDirs?.length ? config.agentDirs : undefined
          );
          if (absPath) {
            store.sessions.setAgentFile(input.sessionID, toRelativeAgentPath(absPath, directory));
          }
        }
      }

      const result = tryPreemptiveRedirect(
        input.sessionID,
        modelKey,
        sessionState.agentName,
        store,
        config,
        logger
      );

      if (result.redirected && result.fallbackModel) {
        const [providerID, ...rest] = result.fallbackModel.split("/");
        const modelID = rest.join("/");
        output.message.model = { providerID, modelID };
        logger.debug("chat.message.redirected", {
          sessionID: input.sessionID,
          from: modelKey,
          to: result.fallbackModel,
        });
      }

      // Remind user on each turn while running on a fallback model
      const current = sessionState.currentModel;
      const original = sessionState.originalModel;
      if (current && original && current !== original) {
        notifyFallbackActive(client, original, current).catch(() => {});
      }
    },

    tool: {
      "fallback-status": createFallbackStatusTool(store, config, client, directory),
    },
  };

  return hooks;
};

export async function handleEvent(
  event: Event,
  client: Parameters<Plugin>[0]["client"],
  store: FallbackStore,
  config: ReturnType<typeof loadConfig>["config"],
  logger: Logger,
  directory: string
): Promise<void> {
  logger.debug("event.received", { type: event.type });

  if (event.type === "session.status") {
    const { sessionID, status } = event.properties;

    if (status.type === "retry") {
      await handleRetry(sessionID, status.message, client, store, config, logger, directory);
    } else if (status.type === "idle") {
      await handleIdle(sessionID, client, store, config, logger);
    }
    return;
  }

  if (event.type === "session.error") {
    const { sessionID, error } = event.properties;
    if (!sessionID || !error) return;

    if (error.name === "APIError") {
      const apiMessage = typeof error.data?.message === "string" ? error.data.message : "";
      const apiStatusCode =
        typeof error.data?.statusCode === "number" ? error.data.statusCode : undefined;

      const category = classifyError(apiMessage, apiStatusCode);
      if (config.defaults.fallbackOn.includes(category)) {
        const result = await attemptFallback(
          sessionID,
          category,
          client,
          store,
          config,
          logger,
          directory
        );
        if (result.success && result.fallbackModel) {
          await notifyFallback(client, result.fromModel ?? null, result.fallbackModel, category);
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

  // omf-owh.3: On compaction, message IDs shift so fallbackHistory is stale,
  // but originalModel/currentModel/agentName/fallbackDepth remain valid.
  if (event.type === "session.compacted") {
    const sessionID = event.properties.sessionID;
    store.sessions.partialReset(sessionID);
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
  logger: Logger,
  directory: string
): Promise<void> {
  // Check if the retry message matches any fallback-triggering pattern
  if (!matchesAnyPattern(message, config.patterns)) {
    logger.debug("retry.nomatch", { sessionId, messageLength: message.length });
    return;
  }

  const category = classifyError(message);
  if (!config.defaults.fallbackOn.includes(category)) {
    logger.debug("retry.ignored", {
      sessionId,
      category,
      messageLength: message.length,
    });
    return;
  }

  // Seed session state with current model if unknown
  const sessionState = store.sessions.get(sessionId);
  if (!sessionState.currentModel) {
    try {
      const msgs = await client.session.messages({ path: { id: sessionId } });
      const latestUserMessage = getLastUserModelAndAgent(msgs.data);
      if (latestUserMessage?.modelKey) {
        store.sessions.setOriginalModel(sessionId, latestUserMessage.modelKey);
        if (latestUserMessage.agentName) {
          store.sessions.setAgentName(sessionId, latestUserMessage.agentName);
          const absPath = resolveAgentFile(
            latestUserMessage.agentName,
            directory,
            config.agentDirs?.length ? config.agentDirs : undefined
          );
          if (absPath) {
            store.sessions.setAgentFile(sessionId, toRelativeAgentPath(absPath, directory));
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  // Resolve agent file if still missing (chat.message usually handles this,
  // but session.error events bypass the hook)
  if (sessionState.agentName && !sessionState.agentFile) {
    const absPath = resolveAgentFile(
      sessionState.agentName,
      directory,
      config.agentDirs?.length ? config.agentDirs : undefined
    );
    if (absPath) {
      store.sessions.setAgentFile(sessionId, toRelativeAgentPath(absPath, directory));
    }
  }

  logger.info("retry.detected", {
    sessionId,
    messageLength: message.length,
    category,
    agentName: sessionState.agentName,
    agentFile: sessionState.agentFile,
  });

  const result = await attemptFallback(
    sessionId,
    category,
    client,
    store,
    config,
    logger,
    directory
  );

  if (result.success && result.fallbackModel) {
    await notifyFallback(client, result.fromModel ?? null, result.fallbackModel, category);
  }
}

export async function handleIdle(
  sessionId: string,
  client: Parameters<Plugin>[0]["client"],
  store: FallbackStore,
  _config: ReturnType<typeof loadConfig>["config"],
  logger: Logger
): Promise<void> {
  const state = store.sessions.get(sessionId);
  if (!state.originalModel) return;
  if (state.currentModel === state.originalModel) {
    state.recoveryNotifiedForModel = null;
    return;
  }

  // Check if original model has recovered
  const health = store.health.get(state.originalModel);
  if (health.state !== "healthy") {
    state.recoveryNotifiedForModel = null;
    return;
  }

  if (state.recoveryNotifiedForModel === state.originalModel) return;

  logger.info("recovery.available", {
    sessionId,
    originalModel: state.originalModel,
    currentModel: state.currentModel,
  });
  await notifyRecovery(client, state.originalModel);
  state.recoveryNotifiedForModel = state.originalModel;
}

function getLastUserModelAndAgent(data: unknown): {
  modelKey: ModelKey;
  agentName: string | null;
} | null {
  if (!Array.isArray(data)) return null;

  for (let i = data.length - 1; i >= 0; i--) {
    const entry = data[i];
    if (!entry || typeof entry !== "object") continue;

    const info = (entry as { info?: unknown }).info;
    if (!info || typeof info !== "object") continue;

    const role = (info as { role?: unknown }).role;
    if (role !== "user") continue;

    const model = (info as { model?: unknown }).model;
    if (!model || typeof model !== "object") continue;

    const providerID = (model as { providerID?: unknown }).providerID;
    const modelID = (model as { modelID?: unknown }).modelID;
    if (typeof providerID !== "string" || typeof modelID !== "string") continue;

    const agent = (info as { agent?: unknown }).agent;

    return {
      modelKey: `${providerID}/${modelID}`,
      agentName: typeof agent === "string" ? agent : null,
    };
  }

  return null;
}
