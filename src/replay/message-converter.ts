import type { Part } from "@opencode-ai/sdk";

type PromptPart =
  | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
  | { type: "file"; mime: string; url: string; filename?: string }
  | { type: "agent"; name: string };

/**
 * Convert stored message parts to the format expected by session.prompt().
 * Filters out synthetic/ignored parts and server-generated part types.
 */
export function convertPartsForPrompt(parts: Part[]): PromptPart[] {
  const result: PromptPart[] = [];

  // Handle null/undefined parts array
  if (!parts || !Array.isArray(parts)) {
    return result;
  }

  for (const part of parts) {
    // Skip null/undefined parts or parts without a type field
    if (!part || typeof part !== "object" || !("type" in part)) {
      continue;
    }

    // Skip synthetic or ignored text parts
    if (part.type === "text") {
      if (part.synthetic || part.ignored) continue;
      result.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "file") {
      result.push({
        type: "file",
        mime: part.mime,
        url: part.url,
        filename: part.filename,
      });
      continue;
    }

    if (part.type === "agent") {
      result.push({ type: "agent", name: part.name });
      continue;
    }

    // Skip: reasoning, tool, step-start, step-finish, snapshot, patch,
    // retry, compaction, subtask — these are server-generated
  }

  return result;
}
