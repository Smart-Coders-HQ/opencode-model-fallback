import type { PluginInput } from "@opencode-ai/plugin";
import type { PluginConfig, ModelKey } from "../types.js";

type Client = PluginInput["client"];

/**
 * Map a session to its agent name, then to the fallback config for that agent.
 * Falls back to wildcard "*" agent config.
 */
export async function resolveAgentName(
  client: Client,
  sessionId: string,
  cachedName: string | null
): Promise<string | null> {
  if (cachedName) return cachedName;
  try {
    const result = await client.session.messages({ path: { id: sessionId } });
    const entries = result.data;
    if (!Array.isArray(entries)) return null;
    // Find last user message to get the agent
    for (let i = entries.length - 1; i >= 0; i--) {
      const { info } = entries[i];
      if (info.role === "user" && typeof (info as { agent?: string }).agent === "string") {
        return (info as { agent: string }).agent;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveFallbackModels(config: PluginConfig, agentName: string | null): ModelKey[] {
  if (agentName && config.agents[agentName]) {
    return config.agents[agentName].fallbackModels;
  }
  return config.agents["*"]?.fallbackModels ?? [];
}
