export type ModelKey = string; // "providerID/modelID"

export type ErrorCategory =
  | "rate_limit"
  | "quota_exceeded"
  | "5xx"
  | "timeout"
  | "overloaded"
  | "unknown";

export type HealthState = "healthy" | "rate_limited" | "cooldown";

export interface ModelHealth {
  modelKey: ModelKey;
  state: HealthState;
  lastFailure: number | null;
  failureCount: number;
  cooldownExpiresAt: number | null;
  retryOriginalAt: number | null;
}

export interface FallbackEvent {
  at: number;
  fromModel: ModelKey;
  toModel: ModelKey;
  reason: ErrorCategory;
  sessionId: string;
}

export interface SessionFallbackState {
  sessionId: string;
  agentName: string | null;
  originalModel: ModelKey | null;
  currentModel: ModelKey | null;
  fallbackDepth: number;
  isProcessing: boolean;
  lastFallbackAt: number | null;
  fallbackHistory: FallbackEvent[];
}

export interface AgentConfig {
  fallbackModels: ModelKey[];
}

export interface FallbackDefaults {
  fallbackOn: ErrorCategory[];
  cooldownMs: number;
  retryOriginalAfterMs: number;
  maxFallbackDepth: number;
}

export interface PluginConfig {
  enabled: boolean;
  defaults: FallbackDefaults;
  agents: Record<string, AgentConfig>;
  patterns: string[];
  logging: boolean;
  logPath: string;
}
