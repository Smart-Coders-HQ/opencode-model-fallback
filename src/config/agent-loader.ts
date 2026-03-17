import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import yaml from "js-yaml";
import type { AgentConfig } from "../types.js";

const MODEL_KEY_RE = /^[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9._-]{1,100}$/;

function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function toRelativeAgentPath(
  absPath: string,
  projectDirectory: string,
  homeDir: string = homedir()
): string {
  const resolvedAbs = resolve(absPath);
  const configBase = resolve(join(homeDir, ".config", "opencode"));
  const projectBase = resolve(projectDirectory);

  if (isPathInside(configBase, resolvedAbs)) {
    const rel = relative(configBase, resolvedAbs);
    if (rel) return rel;
  }

  if (isPathInside(projectBase, resolvedAbs)) {
    const rel = relative(projectBase, resolvedAbs);
    if (rel) return rel;
  }

  return basename(absPath);
}

function stemName(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function collectFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return [];

  const baseDir = resolve(dir);
  let baseRealPath = baseDir;
  try {
    baseRealPath = realpathSync(baseDir);
  } catch {
    return [];
  }

  try {
    let entries: string[];
    if (recursive) {
      entries = readdirSync(baseDir, { recursive: true }) as string[];
    } else {
      entries = readdirSync(baseDir) as string[];
    }

    return entries
      .filter((e) => e.endsWith(".md") || e.endsWith(".json"))
      .map((e) => {
        const candidatePath = resolve(join(baseDir, e));
        if (!isPathInside(baseDir, candidatePath)) return null;

        try {
          const realPath = realpathSync(candidatePath);
          if (!isPathInside(baseRealPath, realPath)) return null;
          if (!statSync(realPath).isFile()) return null;
          return realPath;
        } catch {
          return null;
        }
      })
      .filter((path): path is string => path !== null);
  } catch {
    return [];
  }
}

function parseFrontmatter(content: string): unknown {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const frontmatter = content.slice(3, end).trim();
  try {
    return yaml.load(frontmatter, { schema: yaml.CORE_SCHEMA });
  } catch {
    return null;
  }
}

function parseAgentFile(filePath: string): { name: string; config: AgentConfig } | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    let data: unknown;

    if (filePath.endsWith(".json")) {
      data = JSON.parse(content);
    } else {
      data = parseFrontmatter(content);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const obj = data as Record<string, unknown>;
    const fallback = obj.fallback;
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return null;

    const models = (fallback as Record<string, unknown>).models;
    if (!Array.isArray(models) || models.length === 0) return null;

    const validModels: string[] = [];
    for (const m of models) {
      if (typeof m !== "string" || !MODEL_KEY_RE.test(m)) {
        console.warn(
          `[model-fallback] agent-loader: skipping invalid model key ${JSON.stringify(m)} in ${filePath}`
        );
        continue;
      }
      validModels.push(m);
    }

    if (validModels.length === 0) return null;

    const name =
      typeof obj.name === "string" && obj.name.length > 0 ? obj.name : stemName(filePath);

    return { name, config: { fallbackModels: validModels } };
  } catch (err) {
    console.warn(`[model-fallback] agent-loader: failed to parse ${filePath}:`, err);
    return null;
  }
}

export function resolveAgentFile(
  agentName: string,
  projectDirectory: string,
  customDirs?: string[],
  homeDir: string = homedir()
): string | null {
  const scanDirs: Array<[string, boolean]> =
    customDirs && customDirs.length > 0
      ? customDirs.map((d) => [d, false] as [string, boolean])
      : [
          [join(homeDir, ".config", "opencode", "agents"), false],
          [join(homeDir, ".config", "opencode", "agent"), true],
          [join(projectDirectory, ".opencode", "agents"), false],
          [join(projectDirectory, ".opencode", "agent"), true],
        ];

  const allFiles: string[] = [];
  for (const [dir, recursive] of scanDirs) {
    allFiles.push(...collectFiles(dir, recursive));
  }

  // Fast path: stem match (no file reads)
  for (const file of allFiles) {
    if (stemName(file) === agentName) return file;
  }

  // Slow path: check explicit `name` field in frontmatter / JSON
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const data = file.endsWith(".json") ? JSON.parse(content) : parseFrontmatter(content);
      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (data as Record<string, unknown>).name === agentName
      ) {
        return file;
      }
    } catch {
      // skip
    }
  }

  return null;
}

export function loadAgentFallbackConfigs(
  projectDirectory: string,
  homeDir: string = homedir()
): Record<string, AgentConfig> {
  const scanDirs: Array<[string, boolean]> = [
    [join(homeDir, ".config", "opencode", "agents"), false],
    [join(homeDir, ".config", "opencode", "agent"), true],
    [join(projectDirectory, ".opencode", "agents"), false],
    [join(projectDirectory, ".opencode", "agent"), true],
  ];

  const result: Record<string, AgentConfig> = {};

  for (const [dir, recursive] of scanDirs) {
    const files = collectFiles(dir, recursive);
    for (const file of files) {
      const parsed = parseAgentFile(file);
      if (parsed) {
        result[parsed.name] = parsed.config;
      }
    }
  }

  return result;
}
