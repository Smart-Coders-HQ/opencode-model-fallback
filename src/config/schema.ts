import { homedir } from "os";
import { isAbsolute, relative, resolve } from "path";
import { z } from "zod";
import { DEFAULT_CONFIG } from "./defaults.js";

const MODEL_KEY_RE = /^[a-zA-Z0-9_-]{1,100}(\/[a-zA-Z0-9._-]{1,100})+$/;
const home = resolve(homedir());

function formatPath(path: Array<PropertyKey>): string {
  return path.map((segment) => String(segment)).join(".");
}

function normalizeLogPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(home, path.slice(2));
  }
  return resolve(path);
}

function isPathWithinHome(path: string): boolean {
  const rel = relative(home, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const modelKey = z.string().regex(MODEL_KEY_RE, "Model key must be 'providerID/modelID'");

const agentConfig = z.object({
  fallbackModels: z.array(modelKey).min(1),
});

const fallbackDefaults = z.object({
  fallbackOn: z
    .array(z.enum(["rate_limit", "quota_exceeded", "5xx", "timeout", "overloaded"]))
    .optional(),
  cooldownMs: z.number().min(10_000).optional(),
  retryOriginalAfterMs: z.number().min(10_000).optional(),
  maxFallbackDepth: z.number().int().min(1).max(10).optional(),
});

const logPathSchema = z
  .string()
  .refine((p) => isPathWithinHome(normalizeLogPath(p)), "logPath must resolve within $HOME");

export const pluginConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaults: fallbackDefaults.optional(),
    agents: z.record(z.string(), agentConfig).optional(),
    patterns: z.array(z.string()).optional(),
    logging: z.boolean().optional(),
    logLevel: z.enum(["debug", "info"]).optional(),
    logPath: logPathSchema.optional(),
    agentDirs: z.array(z.string()).optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof pluginConfigSchema>;

export function parseConfig(raw: unknown): {
  config: RawConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("Config warning at root: expected object — using default");
    return { config: {}, warnings };
  }

  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    "enabled",
    "defaults",
    "agents",
    "patterns",
    "logging",
    "logLevel",
    "logPath",
    "agentDirs",
  ]);

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      warnings.push(`Config warning at ${key}: unknown field — using default`);
    }
  }

  const config: RawConfig = {};

  const enabledResult = z.boolean().safeParse(obj.enabled);
  if (obj.enabled !== undefined) {
    if (enabledResult.success) {
      config.enabled = enabledResult.data;
    } else {
      warnings.push(
        `Config warning at enabled: ${enabledResult.error.issues[0].message} — using default`
      );
    }
  }

  if (obj.defaults !== undefined) {
    if (!obj.defaults || typeof obj.defaults !== "object" || Array.isArray(obj.defaults)) {
      warnings.push("Config warning at defaults: expected object — using default");
    } else {
      const defaultsObj = obj.defaults as Record<string, unknown>;
      const parsedDefaults: NonNullable<RawConfig["defaults"]> = {};

      const fallbackOnResult = fallbackDefaults.shape.fallbackOn.safeParse(defaultsObj.fallbackOn);
      if (defaultsObj.fallbackOn !== undefined) {
        if (fallbackOnResult.success && fallbackOnResult.data !== undefined) {
          parsedDefaults.fallbackOn = fallbackOnResult.data;
        } else if (!fallbackOnResult.success) {
          for (const issue of fallbackOnResult.error.issues) {
            const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
            warnings.push(
              `Config warning at defaults.fallbackOn${suffix}: ${issue.message} — using default`
            );
          }
        }
      }

      const cooldownResult = fallbackDefaults.shape.cooldownMs.safeParse(defaultsObj.cooldownMs);
      if (defaultsObj.cooldownMs !== undefined) {
        if (cooldownResult.success && cooldownResult.data !== undefined) {
          parsedDefaults.cooldownMs = cooldownResult.data;
        } else if (!cooldownResult.success) {
          for (const issue of cooldownResult.error.issues) {
            const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
            warnings.push(
              `Config warning at defaults.cooldownMs${suffix}: ${issue.message} — using default`
            );
          }
        }
      }

      const retryResult = fallbackDefaults.shape.retryOriginalAfterMs.safeParse(
        defaultsObj.retryOriginalAfterMs
      );
      if (defaultsObj.retryOriginalAfterMs !== undefined) {
        if (retryResult.success && retryResult.data !== undefined) {
          parsedDefaults.retryOriginalAfterMs = retryResult.data;
        } else if (!retryResult.success) {
          for (const issue of retryResult.error.issues) {
            const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
            warnings.push(
              `Config warning at defaults.retryOriginalAfterMs${suffix}: ${issue.message} — using default`
            );
          }
        }
      }

      const depthResult = fallbackDefaults.shape.maxFallbackDepth.safeParse(
        defaultsObj.maxFallbackDepth
      );
      if (defaultsObj.maxFallbackDepth !== undefined) {
        if (depthResult.success && depthResult.data !== undefined) {
          parsedDefaults.maxFallbackDepth = depthResult.data;
        } else if (!depthResult.success) {
          for (const issue of depthResult.error.issues) {
            const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
            warnings.push(
              `Config warning at defaults.maxFallbackDepth${suffix}: ${issue.message} — using default`
            );
          }
        }
      }

      for (const key of Object.keys(defaultsObj)) {
        if (!Object.hasOwn(fallbackDefaults.shape, key)) {
          warnings.push(`Config warning at defaults.${key}: unknown field — using default`);
        }
      }

      if (Object.keys(parsedDefaults).length > 0) {
        config.defaults = parsedDefaults;
      }
    }
  }

  if (obj.agents !== undefined) {
    if (!obj.agents || typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
      warnings.push("Config warning at agents: expected object — using default");
    } else {
      const parsedAgents: Record<string, { fallbackModels: string[] }> = {};
      for (const [agentName, agentValue] of Object.entries(obj.agents as Record<string, unknown>)) {
        const agentResult = agentConfig.safeParse(agentValue);
        if (agentResult.success) {
          parsedAgents[agentName] = agentResult.data;
          continue;
        }

        for (const issue of agentResult.error.issues) {
          const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
          warnings.push(
            `Config warning at agents.${agentName}${suffix}: ${issue.message} — using default`
          );
        }
      }

      config.agents = parsedAgents;
    }
  }

  if (obj.patterns !== undefined) {
    const patternsResult = z.array(z.string()).safeParse(obj.patterns);
    if (patternsResult.success) {
      config.patterns = patternsResult.data;
    } else {
      for (const issue of patternsResult.error.issues) {
        const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
        warnings.push(`Config warning at patterns${suffix}: ${issue.message} — using default`);
      }
    }
  }

  if (obj.logging !== undefined) {
    const loggingResult = z.boolean().safeParse(obj.logging);
    if (loggingResult.success) {
      config.logging = loggingResult.data;
    } else {
      warnings.push(
        `Config warning at logging: ${loggingResult.error.issues[0].message} — using default`
      );
    }
  }

  if (obj.logLevel !== undefined) {
    const logLevelResult = z.enum(["debug", "info"]).safeParse(obj.logLevel);
    if (logLevelResult.success) {
      config.logLevel = logLevelResult.data;
    } else {
      warnings.push(
        `Config warning at logLevel: ${logLevelResult.error.issues[0].message} — using default`
      );
    }
  }

  if (obj.logPath !== undefined) {
    const logPathResult = logPathSchema.safeParse(obj.logPath);
    if (logPathResult.success) {
      config.logPath = obj.logPath as string;
    } else {
      for (const issue of logPathResult.error.issues) {
        const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
        warnings.push(`Config warning at logPath${suffix}: ${issue.message} — using default`);
      }
    }
  }

  if (obj.agentDirs !== undefined) {
    const agentDirsResult = z.array(z.string()).safeParse(obj.agentDirs);
    if (agentDirsResult.success) {
      config.agentDirs = agentDirsResult.data;
    } else {
      for (const issue of agentDirsResult.error.issues) {
        const suffix = issue.path.length > 0 ? `.${formatPath(issue.path)}` : "";
        warnings.push(`Config warning at agentDirs${suffix}: ${issue.message} — using default`);
      }
    }
  }

  return { config, warnings };
}

export function mergeWithDefaults(raw: RawConfig): import("../types.js").PluginConfig {
  const def = DEFAULT_CONFIG;
  const logPath = raw.logPath ? normalizeLogPath(raw.logPath) : def.logPath;

  return {
    enabled: raw.enabled ?? def.enabled,
    defaults: {
      fallbackOn: raw.defaults?.fallbackOn ?? def.defaults.fallbackOn,
      cooldownMs: raw.defaults?.cooldownMs ?? def.defaults.cooldownMs,
      retryOriginalAfterMs: raw.defaults?.retryOriginalAfterMs ?? def.defaults.retryOriginalAfterMs,
      maxFallbackDepth: raw.defaults?.maxFallbackDepth ?? def.defaults.maxFallbackDepth,
    },
    agents: raw.agents ?? def.agents,
    patterns: raw.patterns ?? def.patterns,
    logging: raw.logging ?? def.logging,
    logLevel: raw.logLevel ?? def.logLevel,
    logPath,
    agentDirs: raw.agentDirs ?? def.agentDirs,
  };
}
