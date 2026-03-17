import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import type { AgentConfig } from "../types.js";

const MODEL_KEY_RE = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/;

function stemName(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function collectFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    let entries: string[];
    if (recursive) {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } else {
      entries = readdirSync(dir) as string[];
    }
    return entries
      .filter((e) => e.endsWith(".md") || e.endsWith(".json"))
      .map((e) => join(dir, e));
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
    return yaml.load(frontmatter);
  } catch {
    return null;
  }
}

function parseAgentFile(
  filePath: string
): { name: string; config: AgentConfig } | null {
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
    if (
      !fallback ||
      typeof fallback !== "object" ||
      Array.isArray(fallback)
    )
      return null;

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
      typeof obj.name === "string" && obj.name.length > 0
        ? obj.name
        : stemName(filePath);

    return { name, config: { fallbackModels: validModels } };
  } catch (err) {
    console.warn(
      `[model-fallback] agent-loader: failed to parse ${filePath}:`,
      err
    );
    return null;
  }
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
