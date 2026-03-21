import type { PluginInput } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

type Client = PluginInput["client"];

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export class Logger {
  private client: Client;
  private logPath: string;
  private enabled: boolean;
  private minLevel: "debug" | "info";
  private dirCreated = false;
  private fileErrorNotified = false;

  constructor(
    client: Client,
    logPath: string,
    enabled: boolean,
    minLevel: "debug" | "info" = "info"
  ) {
    this.client = client;
    this.logPath = logPath;
    this.enabled = enabled;
    this.minLevel = minLevel;
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const sanitizedFields = sanitizeFields(fields);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...sanitizedFields,
    };

    const shouldWrite = this.enabled && (this.minLevel === "debug" || level !== "debug");
    if (shouldWrite) {
      this.writeToFile(entry);
    }

    // Always log to OpenCode's native log system at info+ level
    if (level !== "debug") {
      const message = `[model-fallback] ${event}${Object.keys(sanitizedFields).length ? " " + JSON.stringify(sanitizedFields) : ""}`;
      this.client.app
        .log({
          body: { service: "model-fallback", level, message },
        })
        .catch(() => {
          /* best-effort */
        });
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  private writeToFile(entry: LogEntry): void {
    try {
      if (!this.dirCreated) {
        mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 });
        this.dirCreated = true;
      }
      // Create the log file with owner-only permissions if it doesn't exist yet
      try {
        writeFileSync(this.logPath, "", { mode: 0o600, flag: "ax" });
      } catch {
        // file already exists — that's fine
      }
      appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      if (!this.fileErrorNotified) {
        this.fileErrorNotified = true;
        const message = `[model-fallback] logging.file.write.failed ${JSON.stringify({
          logPath: this.logPath,
          error: summarizeError(err),
        })}`;
        this.client.app
          .log({
            body: { service: "model-fallback", level: "warn", message },
          })
          .catch(() => {
            /* best-effort */
          });
      }
    }
  }
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = sanitizeValue(key, value);
  }
  return out;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (isSensitiveKey(key)) {
    if (typeof value === "string") {
      return { redacted: true, length: value.length };
    }
    if (value instanceof Error) {
      return { redacted: true, type: value.name, code: getErrorCode(value) };
    }
    return { redacted: true, type: typeof value };
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|_)(message|prompt|content|parts|error|err|stack|body)(?:$|_)/i.test(key);
}

function getErrorCode(err: Error): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function summarizeError(err: unknown): { type: string; code?: string } {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown };
    return {
      type: typeof e.name === "string" ? e.name : "Error",
      code: typeof e.code === "string" ? e.code : undefined,
    };
  }
  return { type: typeof err };
}
