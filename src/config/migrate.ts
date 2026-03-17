/**
 * Auto-migration from old `rate-limit-fallback.json` format:
 *   { fallbackModel: "providerID/modelID", cooldownMs, patterns, logging }
 * → new format:
 *   { agents: { "*": { fallbackModels: ["providerID/modelID"] } }, ... }
 */

export interface OldConfig {
  fallbackModel?: string;
  enabled?: boolean;
  cooldownMs?: number;
  patterns?: string[];
  logging?: boolean;
}

export function isOldFormat(raw: unknown): raw is OldConfig {
  if (typeof raw !== "object" || raw === null) return false;
  return "fallbackModel" in raw && typeof (raw as OldConfig).fallbackModel === "string";
}

export function migrateOldConfig(old: OldConfig): Record<string, unknown> {
  const migrated: Record<string, unknown> = {};

  if (typeof old.enabled === "boolean") migrated.enabled = old.enabled;
  if (typeof old.logging === "boolean") migrated.logging = old.logging;
  if (Array.isArray(old.patterns)) migrated.patterns = old.patterns;

  if (old.fallbackModel) {
    migrated.agents = {
      "*": { fallbackModels: [old.fallbackModel] },
    };
  }

  if (typeof old.cooldownMs === "number") {
    migrated.defaults = { cooldownMs: old.cooldownMs };
  }

  return migrated;
}
