import type { PluginInput } from "@opencode-ai/plugin";
import type { ModelKey, PluginConfig } from "../types.js";

type Client = PluginInput["client"];

function normalizeAgentName(agentName: string): string {
  const compact = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.endsWith("agent") ? compact.slice(0, -5) : compact;
}

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

  if (agentName) {
    const normalized = normalizeAgentName(agentName);
    const matches = Object.entries(config.agents).filter(
      ([name]) => name !== "*" && normalizeAgentName(name) === normalized
    );
    if (matches.length === 1) {
      return matches[0][1].fallbackModels;
    }
  }

  return config.agents["*"]?.fallbackModels ?? [];
}
