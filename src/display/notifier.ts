import type { PluginInput } from "@opencode-ai/plugin";
import type { ErrorCategory, ModelKey } from "../types.js";

type Client = PluginInput["client"];

export async function notifyFallback(
  client: Client,
  from: ModelKey | null,
  to: ModelKey,
  reason: ErrorCategory
): Promise<void> {
  const fromLabel = from ? labelModel(from) : "current model";
  const message = `Model fallback: switched from ${fromLabel} to ${labelModel(to)} (${reason})`;
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
  const message = `Using ${labelModel(currentModel)} (fallback from ${labelModel(originalModel)})`;
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
  const message = `Original model ${labelModel(originalModel)} is available again`;
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

export function labelModel(key: ModelKey): string {
  const slash = key.indexOf("/");
  if (slash === -1) return key;
  const provider = key.slice(0, slash);
  const model = key.slice(slash + 1);
  return `${model} [${provider}]`;
}
