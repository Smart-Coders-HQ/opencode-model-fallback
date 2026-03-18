import type { PluginInput } from "@opencode-ai/plugin";
import type { ErrorCategory, ModelKey } from "../types.js";

type Client = PluginInput["client"];

export async function notifyFallback(
  client: Client,
  from: ModelKey | null,
  to: ModelKey,
  reason: ErrorCategory
): Promise<void> {
  const fromLabel = from ? shortModelName(from) : "current model";
  const message = `Model fallback: switched from ${fromLabel} to ${shortModelName(to)} (${reason})`;
  await client.tui
    .showToast({
      body: {
        title: "Model Fallback",
        message,
        variant: "warning",
        duration: 6000,
      },
    })
    .catch(() => {
      /* TUI may not be available in all contexts */
    });
}

export async function notifyFallbackActive(
  client: Client,
  originalModel: ModelKey,
  currentModel: ModelKey
): Promise<void> {
  const message = `Using ${shortModelName(currentModel)} (fallback from ${shortModelName(originalModel)})`;
  await client.tui
    .showToast({
      body: {
        title: "Fallback Active",
        message,
        variant: "warning",
        duration: 4000,
      },
    })
    .catch(() => {});
}

export async function notifyRecovery(client: Client, originalModel: ModelKey): Promise<void> {
  const message = `Original model ${shortModelName(originalModel)} is available again`;
  await client.tui
    .showToast({
      body: {
        title: "Model Recovered",
        message,
        variant: "info",
        duration: 5000,
      },
    })
    .catch(() => {});
}

function shortModelName(key: ModelKey): string {
  // "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4-20250514"
  const parts = key.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : key;
}
