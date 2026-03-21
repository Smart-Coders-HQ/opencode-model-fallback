import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger } from "../src/logging/logger.js";
import { ensureFallbackStatusCommand } from "../src/plugin.js";
import { makeMockClient } from "./helpers/mock-client.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-fallback-command-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("ensureFallbackStatusCommand", () => {
  it("creates the fallback-status command file", () => {
    const dir = makeTempDir();
    const cmdPath = join(dir, "commands", "fallback-status.md");
    const { client } = makeMockClient();
    const logger = new Logger(client, join(dir, "log.jsonl"), false);

    ensureFallbackStatusCommand(logger, cmdPath);

    expect(readFileSync(cmdPath, "utf-8")).toBe(
      "Call the fallback-status tool and display the full output.\n"
    );
  });

  it("silently accepts existing command file", () => {
    const dir = makeTempDir();
    const cmdPath = join(dir, "commands", "fallback-status.md");
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, join(dir, "log.jsonl"), false);

    ensureFallbackStatusCommand(logger, cmdPath);
    ensureFallbackStatusCommand(logger, cmdPath);

    const writeFailureLogs = calls.logs.filter((l) =>
      l.message.includes("fallback-status.command.write.failed")
    );
    expect(writeFailureLogs).toHaveLength(0);
  });

  it("logs a warning when command file creation fails", () => {
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, "/tmp/test.log", false);

    ensureFallbackStatusCommand(logger, "/dev/null/dir/fallback-status.md");

    const writeFailureLogs = calls.logs.filter((l) =>
      l.message.includes("fallback-status.command.write.failed")
    );
    expect(writeFailureLogs).toHaveLength(1);
  });
});
