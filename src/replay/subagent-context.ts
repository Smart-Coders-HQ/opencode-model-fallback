import type { Part } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger.js";

interface MessageEntry {
  info?: {
    role?: unknown;
    id?: unknown;
    agent?: unknown;
    model?: { providerID: string; modelID: string };
  };
  parts?: unknown;
}

export interface SubagentSnapshot {
  agentName: string;
  parts: Part[];
  messageId: string;
}

/**
 * Captures completed subagent messages between the last user message and the end
 * of the message list. Only captures messages from agents different from the
 * primary session agent.
 */
export function captureSubagentContext(
  messageEntries: unknown[],
  lastUserMessageId: string,
  primaryAgentName: string | null,
  logger: Logger,
): SubagentSnapshot[] {
  const snapshots: SubagentSnapshot[] = [];
  let foundLastUser = false;

  for (const entry of messageEntries) {
    if (!entry || typeof entry !== "object") continue;

    const e = entry as MessageEntry;
    const info = e.info;
    if (!info || typeof info !== "object") continue;

    const id = typeof info.id === "string" ? info.id : null;
    if (!id) continue;

    // Start capturing after we pass the last user message
    if (id === lastUserMessageId) {
      foundLastUser = true;
      continue;
    }
    if (!foundLastUser) continue;

    // Only capture assistant messages (not user, not tool results)
    const role = typeof info.role === "string" ? info.role : null;
    if (role !== "assistant") continue;

    // Only capture from different agents (subagents)
    const agentName = typeof info.agent === "string" ? info.agent : null;
    if (!agentName || agentName === primaryAgentName) continue;

    // Capture the text parts
    const rawParts = Array.isArray(e.parts) ? e.parts : [];
    const textParts = rawParts.filter(
      (p): p is Part =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: string }).type === "text" &&
        "text" in p &&
        typeof (p as { text: unknown }).text === "string" &&
        ((p as { text: string }).text.length > 0),
    );

    if (textParts.length === 0) continue;

    snapshots.push({
      agentName,
      parts: textParts as Part[],
      messageId: id,
    });

    logger.debug("subagent.snapshot.captured", {
      agentName,
      messageId: id,
      partCount: textParts.length,
    });
  }

  return snapshots;
}

/**
 * Converts captured subagent snapshots into prompt parts that can be
 * injected after a revert to preserve context.
 */
export function snapshotsToPromptParts(
  snapshots: SubagentSnapshot[],
): Array<{ type: "text"; text: string }> {
  if (snapshots.length === 0) return [];

  const parts: Array<{ type: "text"; text: string }> = [];

  parts.push({
    type: "text",
    text: "[CONTEXT PRESERVED - Previous subagent results recovered after model fallback]\n",
  });

  for (const snapshot of snapshots) {
    const textContent = snapshot.parts
      .filter((p): p is Part & { type: "text"; text: string } =>
        typeof p === "object" && p !== null && "type" in p && p.type === "text" && "text" in p,
      )
      .map((p) => p.text)
      .join("\n");

    parts.push({
      type: "text",
      text: `[Subagent: ${snapshot.agentName}]\n${textContent}\n`,
    });
  }

  parts.push({
    type: "text",
    text: "[END PRESERVED CONTEXT]\n",
  });

  return parts;
}
