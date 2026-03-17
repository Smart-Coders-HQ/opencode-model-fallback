import { z } from "zod";
import { homedir } from "os";
import { DEFAULT_CONFIG } from "./defaults.js";

const MODEL_KEY_RE = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/;

const modelKey = z
  .string()
  .regex(MODEL_KEY_RE, "Model key must be 'providerID/modelID'");

const agentConfig = z.object({
  fallbackModels: z.array(modelKey).min(1),
});

const fallbackDefaults = z.object({
  fallbackOn: z
    .array(
      z.enum(["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"])
    )
    .optional(),
  cooldownMs: z.number().min(10_000).optional(),
  retryOriginalAfterMs: z.number().min(10_000).optional(),
  maxFallbackDepth: z.number().int().min(1).max(10).optional(),
});

const home = homedir();

export const pluginConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaults: fallbackDefaults.optional(),
    agents: z.record(z.string(), agentConfig).optional(),
    patterns: z.array(z.string()).optional(),
    logging: z.boolean().optional(),
    logPath: z
      .string()
      .refine(
        (p) => p.startsWith(home) || p.startsWith("~/"),
        "logPath must be within $HOME"
      )
      .optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof pluginConfigSchema>;

export function parseConfig(raw: unknown): {
  config: RawConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const result = pluginConfigSchema.safeParse(raw);

  if (!result.success) {
    for (const issue of result.error.issues) {
      warnings.push(`Config warning at ${issue.path.join(".")}: ${issue.message} — using default`);
    }
    // Fall back to empty object; merging with defaults will fill in values
    return { config: {}, warnings };
  }

  return { config: result.data, warnings };
}

export function mergeWithDefaults(raw: RawConfig): import("../types.js").PluginConfig {
  const def = DEFAULT_CONFIG;
  const logPath =
    raw.logPath?.startsWith("~/")
      ? raw.logPath.replace("~/", `${homedir()}/`)
      : raw.logPath ?? def.logPath;

  return {
    enabled: raw.enabled ?? def.enabled,
    defaults: {
      fallbackOn: raw.defaults?.fallbackOn ?? def.defaults.fallbackOn,
      cooldownMs: raw.defaults?.cooldownMs ?? def.defaults.cooldownMs,
      retryOriginalAfterMs:
        raw.defaults?.retryOriginalAfterMs ?? def.defaults.retryOriginalAfterMs,
      maxFallbackDepth:
        raw.defaults?.maxFallbackDepth ?? def.defaults.maxFallbackDepth,
    },
    agents: raw.agents ?? def.agents,
    patterns: raw.patterns ?? def.patterns,
    logging: raw.logging ?? def.logging,
    logPath,
  };
}
