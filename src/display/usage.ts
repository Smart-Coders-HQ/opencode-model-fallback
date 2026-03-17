import type { PluginInput } from "@opencode-ai/plugin";
import type { SessionFallbackState } from "../types.js";

type Client = PluginInput["client"];

export interface FallbackUsageSummary {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  fallbackPeriods: Array<{
    model: string;
    from: number;
    to: number | null;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
}

/**
 * Query OpenCode's native session message data to enrich with fallback context.
 * Groups token/cost data by model, correlated with fallback history timestamps.
 */
export async function getFallbackUsage(
  client: Client,
  state: SessionFallbackState
): Promise<FallbackUsageSummary> {
  const summary: FallbackUsageSummary = {
    sessionId: state.sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    fallbackPeriods: [],
  };

  try {
    const result = await client.session.messages({ path: { id: state.sessionId } });
    const entries = result.data ?? [];

    for (const entry of entries) {
      const msg = entry.info;
      if (msg.role !== "assistant") continue;

      summary.totalInputTokens += msg.tokens?.input ?? 0;
      summary.totalOutputTokens += msg.tokens?.output ?? 0;
      summary.totalCost += msg.cost ?? 0;
    }

    // Build fallback periods from history
    for (let i = 0; i < state.fallbackHistory.length; i++) {
      const event = state.fallbackHistory[i];
      const nextEvent = state.fallbackHistory[i + 1];

      const periodTokens = getPeriodTokens(entries, event.at, nextEvent?.at ?? null);
      summary.fallbackPeriods.push({
        model: event.toModel,
        from: event.at,
        to: nextEvent?.at ?? null,
        ...periodTokens,
      });
    }
  } catch {
    // Best-effort — return empty summary on failure
  }

  return summary;
}

function getPeriodTokens(
  entries: Array<{ info: { role: string; time: { created: number; completed?: number }; tokens?: { input: number; output: number }; cost?: number }; parts: unknown[] }>,
  fromMs: number,
  toMs: number | null
): { inputTokens: number; outputTokens: number; cost: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  for (const entry of entries) {
    const msg = entry.info;
    if (msg.role !== "assistant") continue;

    const created = msg.time.created;
    if (created < fromMs) continue;
    if (toMs !== null && created >= toMs) continue;

    inputTokens += msg.tokens?.input ?? 0;
    outputTokens += msg.tokens?.output ?? 0;
    cost += msg.cost ?? 0;
  }

  return { inputTokens, outputTokens, cost };
}
