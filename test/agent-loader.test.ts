import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAgentFallbackConfigs } from "../src/config/agent-loader.js";
import { loadConfig } from "../src/config/loader.js";

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "agent-loader-test-"));
}

describe("loadAgentFallbackConfigs", () => {
  let dir: string;
  let agentsDir: string;
  let agentDir: string;

  beforeEach(() => {
    dir = mktemp();
    agentsDir = join(dir, ".opencode", "agents");
    agentDir = join(dir, ".opencode", "agent");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses fallback.models from markdown frontmatter", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "coder.md"),
      `---
name: CoderAgent
model: openai/gpt-5
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
    - google/gemini-flash-2-5
---
# Agent description
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["CoderAgent"]).toEqual({
      fallbackModels: ["anthropic/claude-sonnet-4-20250514", "google/gemini-flash-2-5"],
    });
  });

  it("parses fallback.models from JSON agent file", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "reviewer.json"),
      JSON.stringify({
        name: "ReviewerAgent",
        model: "openai/gpt-5",
        fallback: {
          models: ["anthropic/claude-sonnet-4-20250514"],
        },
      })
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["ReviewerAgent"]).toEqual({
      fallbackModels: ["anthropic/claude-sonnet-4-20250514"],
    });
  });

  it("uses name field when present", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "my-agent.md"),
      `---
name: CustomName
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["CustomName"]).toBeDefined();
    expect(configs["my-agent"]).toBeUndefined();
  });

  it("falls back to filename stem when name absent", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "code-reviewer.md"),
      `---
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["code-reviewer"]).toBeDefined();
    expect(configs["code-reviewer"].fallbackModels).toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });

  it("skips files with no fallback section", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "no-fallback.md"),
      `---
name: NoFallback
model: openai/gpt-5
---
`
    );
    writeFileSync(
      join(agentsDir, "no-fallback.json"),
      JSON.stringify({ name: "NoFallbackJson", model: "openai/gpt-5" })
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(Object.keys(configs)).toHaveLength(0);
  });

  it("skips invalid model keys with a warning, keeps valid ones", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "mixed.md"),
      `---
name: MixedAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
    - not-valid
    - also/valid-model
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["MixedAgent"]).toBeDefined();
    expect(configs["MixedAgent"].fallbackModels).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "also/valid-model",
    ]);
  });

  it("skips file entirely when all model keys are invalid", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "bad-models.md"),
      `---
name: BadAgent
fallback:
  models:
    - not-a-valid-key
    - also-bad
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["BadAgent"]).toBeUndefined();
  });

  it("later-scanned directory overrides earlier for same agent name", () => {
    // agents/ (path 3) is scanned before agent/ (path 4) — later wins
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "shared.md"),
      `---
name: SharedAgent
fallback:
  models:
    - openai/gpt-4
---
`
    );
    writeFileSync(
      join(agentDir, "shared.md"),
      `---
name: SharedAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    // agent/ is scanned after agents/, so it wins
    expect(configs["SharedAgent"].fallbackModels).toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });

  it("finds files recursively in agent/ subdirectories", () => {
    const subDir = join(agentDir, "subteam");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, "nested.md"),
      `---
name: NestedAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["NestedAgent"]).toBeDefined();
  });

  it("global agent dirs override project dirs when using homeDir override", () => {
    // Simulate global path via homeDir override, then project path
    const fakeHome = mktemp();
    try {
      const globalAgentsDir = join(fakeHome, ".config", "opencode", "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      mkdirSync(agentsDir, { recursive: true });

      writeFileSync(
        join(globalAgentsDir, "shared.md"),
        `---
name: SharedAgent
fallback:
  models:
    - openai/gpt-4
---
`
      );
      writeFileSync(
        join(agentsDir, "shared.md"),
        `---
name: SharedAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
      );

      // Project-local (paths 3,4) override global (paths 1,2)
      const configs = loadAgentFallbackConfigs(dir, fakeHome);
      expect(configs["SharedAgent"].fallbackModels).toEqual(["anthropic/claude-sonnet-4-20250514"]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("loadConfig agent file merge", () => {
  let dir: string;

  beforeEach(() => {
    dir = mktemp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("model-fallback.json explicit config overrides agent-file config", () => {
    const agentsDir = join(dir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "coder.md"),
      `---
name: CoderAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    writeFileSync(
      join(dir, ".opencode", "model-fallback.json"),
      JSON.stringify({
        agents: {
          CoderAgent: { fallbackModels: ["openai/gpt-4o"] },
        },
      })
    );

    const result = loadConfig(dir);
    // model-fallback.json wins over agent file
    expect(result.config.agents["CoderAgent"].fallbackModels).toEqual(["openai/gpt-4o"]);
  });

  it("agent-file config is used when no model-fallback.json exists", () => {
    const agentsDir = join(dir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "coder.md"),
      `---
name: CoderAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const result = loadConfig(dir);
    expect(result.config.agents["CoderAgent"]).toEqual({
      fallbackModels: ["anthropic/claude-sonnet-4-20250514"],
    });
  });

  it("agent-file config coexists with wildcard from model-fallback.json", () => {
    const agentsDir = join(dir, ".opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "coder.md"),
      `---
name: CoderAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    writeFileSync(
      join(dir, ".opencode", "model-fallback.json"),
      JSON.stringify({
        agents: {
          "*": { fallbackModels: ["google/gemini-flash-2-5"] },
        },
      })
    );

    const result = loadConfig(dir);
    expect(result.config.agents["CoderAgent"].fallbackModels).toEqual([
      "anthropic/claude-sonnet-4-20250514",
    ]);
    expect(result.config.agents["*"].fallbackModels).toEqual(["google/gemini-flash-2-5"]);
  });
});

describe("loadAgentFallbackConfigs — path traversal security", () => {
  let dir: string;
  let agentsDir: string;

  beforeEach(() => {
    dir = mktemp();
    agentsDir = join(dir, ".opencode", "agents");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects symlinks pointing outside the base directory", () => {
    const { symlinkSync } = require("fs");
    mkdirSync(agentsDir, { recursive: true });

    // Create a file outside the base directory
    const outsideDir = mktemp();
    try {
      const outsideFile = join(outsideDir, "malicious.md");
      writeFileSync(
        outsideFile,
        `---
name: MaliciousAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
      );

      // Create a symlink inside agentsDir pointing to the outside file
      const symlinkPath = join(agentsDir, "symlink.md");
      try {
        symlinkSync(outsideFile, symlinkPath);
      } catch (err) {
        // Skip test if symlinks are not supported (e.g., Windows without admin)
        console.warn("Skipping symlink test: symlinks not supported");
        return;
      }

      // Load configs — symlinked file should NOT be included
      const configs = loadAgentFallbackConfigs(dir, dir);
      expect(configs["MaliciousAgent"]).toBeUndefined();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("includes valid nested files within the recursive agent/ directory", () => {
    // .opencode/agents/ is non-recursive; .opencode/agent/ is recursive
    const agentDir = join(dir, ".opencode", "agent");
    const subDir = join(agentDir, "team");
    mkdirSync(subDir, { recursive: true });

    writeFileSync(
      join(subDir, "nested.md"),
      `---
name: NestedAgent
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
---
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["NestedAgent"]).toBeDefined();
    expect(configs["NestedAgent"].fallbackModels).toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });
});

describe("parseFrontmatter — YAML safe schema", () => {
  let dir: string;
  let agentsDir: string;

  beforeEach(() => {
    dir = mktemp();
    agentsDir = join(dir, ".opencode", "agents");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects YAML with !!js/function tag (malicious code execution)", () => {
    mkdirSync(agentsDir, { recursive: true });

    // Write a file with malicious YAML frontmatter
    writeFileSync(
      join(agentsDir, "malicious.md"),
      `---
name: MaliciousAgent
fallback:
  models: !!js/function >
    function() { require('fs').unlinkSync('/etc/passwd'); }
---
# Agent description
`
    );

    // Load configs — malicious file should produce no config entry
    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["MaliciousAgent"]).toBeUndefined();
  });

  it("parses valid YAML with nested objects successfully", () => {
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "valid.md"),
      `---
name: ValidAgent
model: openai/gpt-5
fallback:
  models:
    - anthropic/claude-sonnet-4-20250514
    - google/gemini-flash-2-5
metadata:
  description: A valid agent
  version: 1.0
---
# Agent description
`
    );

    const configs = loadAgentFallbackConfigs(dir, dir);
    expect(configs["ValidAgent"]).toBeDefined();
    expect(configs["ValidAgent"].fallbackModels).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "google/gemini-flash-2-5",
    ]);
  });

  it("rejects YAML with other dangerous tags", () => {
    mkdirSync(agentsDir, { recursive: true });

    // Try various dangerous YAML tags
    const dangerousTags = ["!!python/object/apply:os.system", "!!java/object", "!!ruby/object"];

    for (const tag of dangerousTags) {
      const filename = `dangerous-${dangerousTags.indexOf(tag)}.md`;
      writeFileSync(
        join(agentsDir, filename),
        `---
name: DangerousAgent${dangerousTags.indexOf(tag)}
fallback:
  models: ${tag}
    - ls -la
---
`
      );
    }

    const configs = loadAgentFallbackConfigs(dir, dir);
    // None of the dangerous agents should be loaded
    expect(configs["DangerousAgent0"]).toBeUndefined();
    expect(configs["DangerousAgent1"]).toBeUndefined();
    expect(configs["DangerousAgent2"]).toBeUndefined();
  });
});
