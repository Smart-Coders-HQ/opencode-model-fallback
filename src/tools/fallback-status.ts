import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { FallbackStore } from "../state/store.js";
import type { PluginConfig } from "../types.js";
import { getFallbackUsage } from "../display/usage.js";
import type { PluginInput } from "@opencode-ai/plugin";

type Client = PluginInput["client"];

export function createFallbackStatusTool(
  store: FallbackStore,
  config: PluginConfig,
  client: Client
): ToolDefinition {
  return tool({
    description:
      "Show the current model fallback status: which models are healthy/rate-limited, fallback history for this session, and usage breakdown by model.",
    args: {
      verbose: tool.schema.boolean().optional().describe(
        "Include detailed token/cost usage per model period"
      ),
    },
    async execute(args, context) {
      const sessionId = context.sessionID;
      const sessionState = store.sessions.get(sessionId);
      const allHealth = store.health.getAll();

      const lines: string[] = ["## Model Fallback Status\n"];

      // Plugin enabled state
      lines.push(`**Plugin:** ${config.enabled ? "enabled" : "disabled"}`);
      lines.push("");

      // Session fallback state
      lines.push("### Current Session");
      lines.push(`- **Session ID:** ${sessionId}`);
      lines.push(`- **Agent:** ${sessionState.agentName ?? "(unknown)"}`);
      lines.push(`- **Original model:** ${sessionState.originalModel ?? "(not set)"}`);
      lines.push(`- **Current model:** ${sessionState.currentModel ?? "(not set)"}`);
      lines.push(`- **Fallback depth:** ${sessionState.fallbackDepth}`);
      lines.push("");

      // Fallback history
      if (sessionState.fallbackHistory.length > 0) {
        lines.push("### Fallback History");
        for (const event of sessionState.fallbackHistory) {
          const time = new Date(event.at).toLocaleTimeString();
          lines.push(
            `- **${time}** — switched from \`${event.fromModel}\` to \`${event.toModel}\` (${event.reason})`
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
          const stateEmoji =
            h.state === "healthy" ? "✓" : h.state === "cooldown" ? "~" : "✗";
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
