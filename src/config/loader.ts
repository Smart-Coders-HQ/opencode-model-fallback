import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import type { PluginConfig } from "../types.js";
import { loadAgentFallbackConfigs } from "./agent-loader.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { isOldFormat, migrateOldConfig } from "./migrate.js";
import { mergeWithDefaults, parseConfig } from "./schema.js";

const CONFIG_FILENAME = "model-fallback.json";
const OLD_CONFIG_FILENAME = "rate-limit-fallback.json";

function candidatePaths(directory: string): string[] {
  const home = homedir();
  return [
    join(directory, ".opencode", CONFIG_FILENAME),
    join(home, ".config", "opencode", CONFIG_FILENAME),
    // Old format candidates (for migration)
    join(directory, ".opencode", OLD_CONFIG_FILENAME),
    join(home, ".config", "opencode", OLD_CONFIG_FILENAME),
  ];
}

export interface LoadResult {
  config: PluginConfig;
  path: string | null;
  warnings: string[];
  migrated: boolean;
}

export function loadConfig(directory: string): LoadResult {
  const agentFileConfigs = loadAgentFallbackConfigs(directory);
  const candidates = candidatePaths(directory);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(candidate, "utf-8"));
    } catch {
      return {
        config: {
          ...DEFAULT_CONFIG,
          agents: { ...agentFileConfigs, ...DEFAULT_CONFIG.agents },
        },
        path: candidate,
        warnings: [`Failed to parse ${basename(candidate)}: invalid JSON — using defaults`],
        migrated: false,
      };
    }

    const isOld = isOldFormat(raw);
    if (isOld) {
      raw = migrateOldConfig(raw as Parameters<typeof migrateOldConfig>[0]);
    }

    const { config: parsed, warnings } = parseConfig(raw);
    const merged = mergeWithDefaults(parsed);
    merged.agents = { ...agentFileConfigs, ...merged.agents };

    return {
      config: merged,
      path: candidate,
      warnings,
      migrated: isOld,
    };
  }

  return {
    config: {
      ...DEFAULT_CONFIG,
      agents: { ...agentFileConfigs, ...DEFAULT_CONFIG.agents },
    },
    path: null,
    warnings: [],
    migrated: false,
  };
}
