import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Logger } from "../src/logging/logger.js";
import { makeMockClient } from "./helpers/mock-client.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-fallback-logger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("Logger", () => {
  it("writes info/warn/error to client.app.log but not debug", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "fallback.log");
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, logPath, false, "debug");

    logger.debug("debug.event");
    logger.info("info.event");
    logger.warn("warn.event");
    logger.error("error.event");

    expect(calls.logs).toHaveLength(3);
    expect(calls.logs.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("suppresses debug file writes when minLevel is info", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "fallback.log");
    const { client } = makeMockClient();
    const logger = new Logger(client, logPath, true, "info");

    logger.debug("debug.event");
    logger.info("info.event");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      event: "info.event",
      level: "info",
    });
  });

  it("redacts sensitive fields in both file and native logs", () => {
    const dir = makeTempDir();
    const logPath = join(dir, "fallback.log");
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, logPath, true, "debug");

    logger.warn("retry.detected", {
      message: "provider response with prompt text",
      err: new Error("secret payload"),
      category: "rate_limit",
    });

    const line = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(line) as {
      message?: { redacted?: boolean; length?: number };
      err?: { redacted?: boolean; type?: string };
      category?: string;
    };

    expect(parsed.message).toEqual({ redacted: true, length: 34 });
    expect(parsed.err).toEqual({ redacted: true, type: "Error" });
    expect(parsed.category).toBe("rate_limit");

    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0]?.message).toContain('"message":{"redacted":true,"length":34}');
    expect(calls.logs[0]?.message).toContain('"err":{"redacted":true,"type":"Error"}');
  });

  it("does not throw when file logging fails and emits one warning", () => {
    const { client, calls } = makeMockClient();
    const logger = new Logger(client, "/dev/null/fallback.log", true, "info");

    logger.info("first.event");
    logger.info("second.event");

    const writeFailureLogs = calls.logs.filter((l) =>
      l.message.includes("logging.file.write.failed")
    );
    expect(writeFailureLogs).toHaveLength(1);
  });
});
