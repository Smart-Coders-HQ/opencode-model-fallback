import type { PluginInput } from "@opencode-ai/plugin";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { resolveAgentFile } from "../config/agent-loader.js";
import { getFallbackUsage } from "../display/usage.js";
import type { FallbackStore } from "../state/store.js";
import type { PluginConfig } from "../types.js";

type Client = PluginInput["client"];

export function createFallbackStatusTool(
  store: FallbackStore,
  config: PluginConfig,
  client: Client,
  directory: string
): ToolDefinition {
  return tool({
    description:
      "Show the current model fallback status: which models are healthy/rate-limited, fallback history for this session, and usage breakdown by model.",
    args: {
      verbose: tool.schema
        .boolean()
        .optional()
        .describe("Include detailed token/cost usage per model period"),
    },
    async execute(args, context) {
      const sessionId = context.sessionID;
      const sessionState = store.sessions.get(sessionId);
      const allHealth = store.health.getAll();

      // Discover active model + agent name when session state is unpopulated
      let activeModel: string | null = null;
      let agentName: string | null = sessionState.agentName;

      if (!sessionState.originalModel) {
        try {
          const msgs = await client.session.messages({
            path: { id: sessionId },
          });
          const latestUserMessage = getLastUserModelAndAgent(msgs.data);
          if (latestUserMessage) {
            activeModel = latestUserMessage.modelKey;
            if (!agentName && latestUserMessage.agentName) {
              agentName = latestUserMessage.agentName;
            }
          }
        } catch {
          // best-effort
        }
      }

      const agentFile = agentName
        ? resolveAgentFile(
            agentName,
            directory,
            config.agentDirs.length ? config.agentDirs : undefined
          )
        : null;
      const agentLabel = agentName
        ? agentFile
          ? `${agentName} (${agentFile})`
          : agentName
        : "(unknown)";

      const lines: string[] = ["## Model Fallback Status\n"];

      // Plugin enabled state
      lines.push(`**Plugin:** ${config.enabled ? "enabled" : "disabled"}`);
      lines.push("");

      // Session fallback state
      lines.push("### Current Session");
      lines.push(`- **Session ID:** ${sessionId}`);
      lines.push(`- **Agent:** ${agentLabel}`);
      lines.push(
        `- **Original model:** ${sessionState.originalModel ?? activeModel ?? "(not set)"}`
      );
      lines.push(`- **Current model:** ${sessionState.currentModel ?? activeModel ?? "(not set)"}`);
      lines.push(`- **Fallback depth:** ${sessionState.fallbackDepth}`);
      lines.push("");

      // Fallback history
      if (sessionState.fallbackHistory.length > 0) {
        lines.push("### Fallback History");
        for (const event of sessionState.fallbackHistory) {
          const time = new Date(event.at).toLocaleTimeString();
          const eventKind = event.trigger === "preemptive" ? "preemptive" : "reactive";
          const eventAgent = event.agentName ?? agentName;
          lines.push(
            `- **${time}** — \`${event.fromModel}\` → \`${event.toModel}\` (${event.reason}, ${eventKind})` +
              (eventAgent ? ` · agent: ${eventAgent}` : "")
          );
        }
        lines.push("");
      }

      // Model health
      lines.push("### Model Health");
      if (allHealth.length === 0) {
        lines.push("- All models healthy (no issues detected)");
      } else {
        for (const h of allHealth) {
          const stateEmoji = h.state === "healthy" ? "✓" : h.state === "cooldown" ? "~" : "✗";
          let detail = `- \`${h.modelKey}\` — **${h.state}** ${stateEmoji}`;
          if (h.state === "rate_limited" && h.cooldownExpiresAt) {
            const secsLeft = Math.max(0, Math.round((h.cooldownExpiresAt - Date.now()) / 1000));
            detail += ` (cooldown in ${secsLeft}s)`;
          } else if (h.state === "cooldown" && h.retryOriginalAt) {
            const secsLeft = Math.max(0, Math.round((h.retryOriginalAt - Date.now()) / 1000));
            detail += ` (recovery in ${secsLeft}s)`;
          }
          if (h.failureCount > 0) detail += ` [${h.failureCount} failures]`;
          lines.push(detail);
        }
      }
      lines.push("");

      // Usage breakdown (verbose only)
      if (args.verbose && sessionState.fallbackHistory.length > 0) {
        const usage = await getFallbackUsage(client, sessionState);
        lines.push("### Usage Summary");
        lines.push(`- **Total input tokens:** ${usage.totalInputTokens.toLocaleString()}`);
        lines.push(`- **Total output tokens:** ${usage.totalOutputTokens.toLocaleString()}`);
        lines.push(`- **Total cost:** $${usage.totalCost.toFixed(6)}`);
        if (usage.fallbackPeriods.length > 0) {
          lines.push("");
          lines.push("**By model period:**");
          for (const period of usage.fallbackPeriods) {
            const from = new Date(period.from).toLocaleTimeString();
            const to = period.to ? new Date(period.to).toLocaleTimeString() : "now";
            lines.push(
              `- \`${period.model}\` (${from}–${to}): ${period.inputTokens.toLocaleString()} in / ${period.outputTokens.toLocaleString()} out / $${period.cost.toFixed(6)}`
            );
          }
        }
      }

      return lines.join("\n");
    },
  });
}

function getLastUserModelAndAgent(data: unknown): {
  modelKey: string;
  agentName: string | null;
} | null {
  if (!Array.isArray(data)) return null;

  for (let i = data.length - 1; i >= 0; i--) {
    const entry = data[i];
    if (!entry || typeof entry !== "object") continue;

    const info = (entry as { info?: unknown }).info;
    if (!info || typeof info !== "object") continue;

    if ((info as { role?: unknown }).role !== "user") continue;

    const model = (info as { model?: unknown }).model;
    if (!model || typeof model !== "object") continue;

    const providerID = (model as { providerID?: unknown }).providerID;
    const modelID = (model as { modelID?: unknown }).modelID;
    if (typeof providerID !== "string" || typeof modelID !== "string") continue;

    const agentName = (info as { agent?: unknown }).agent;

    return {
      modelKey: `${providerID}/${modelID}`,
      agentName: typeof agentName === "string" ? agentName : null,
    };
  }

  return null;
}
