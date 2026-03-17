import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { PluginInput } from "@opencode-ai/plugin";

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
  private dirCreated = false;

  constructor(client: Client, logPath: string, enabled: boolean) {
    this.client = client;
    this.logPath = logPath;
    this.enabled = enabled;
  }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };

    if (this.enabled) {
      this.writeToFile(entry);
    }

    // Always log to OpenCode's native log system at info+ level
    if (level !== "debug") {
      const message = `[model-fallback] ${event}${Object.keys(fields).length ? " " + JSON.stringify(fields) : ""}`;
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
        mkdirSync(dirname(this.logPath), { recursive: true });
        this.dirCreated = true;
      }
      appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Swallow file logging errors — never crash the plugin
    }
  }
}
