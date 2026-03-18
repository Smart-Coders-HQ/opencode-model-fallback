import { homedir } from "os";
import { join } from "path";
import type { PluginConfig } from "../types.js";

export const DEFAULT_PATTERNS = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "capacity exceeded",
  "credits exhausted",
  "billing limit",
  "429",
];

export const DEFAULT_LOG_PATH = join(homedir(), ".local/share/opencode/logs/model-fallback.log");

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  defaults: {
    fallbackOn: ["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"],
    cooldownMs: 300_000, // 5 minutes
    retryOriginalAfterMs: 900_000, // 15 minutes
    maxFallbackDepth: 3,
  },
  agents: {
    "*": {
      fallbackModels: [],
    },
  },
  patterns: DEFAULT_PATTERNS,
  logging: true,
  logLevel: "info" as const,
  logPath: DEFAULT_LOG_PATH,
  agentDirs: [],
};
