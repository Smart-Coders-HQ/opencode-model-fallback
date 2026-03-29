import type { ErrorCategory } from "../types.js";
import { matchesAnyPattern } from "./patterns.js";

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "ratelimit",
  "too many requests",
  "usage limit",
  "resource exhausted",
  "resource_exhausted",
  "429",
];

const QUOTA_PATTERNS = [
  "quota exceeded",
  "credits exhausted",
  "billing limit",
  "credit limit",
  "insufficient quota",
  "insufficient credit",
  "insufficient credits",
  "out of credits",
];

const OVERLOADED_PATTERNS = [
  "overloaded",
  "capacity exceeded",
  "server is busy",
  "engine is currently overloaded",
];

const TIMEOUT_PATTERNS = ["timeout", "timed out", "request timeout", "connection timeout"];

const SERVER_ERROR_PATTERNS = [
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "500",
  "502",
  "503",
  "504",
];

export function classifyError(error: unknown, statusCode?: number): ErrorCategory {
  const message =
    typeof error === "string"
      ? error
      : (error as { message?: string })?.message || JSON.stringify(error);
  const raw = String(message || "")
    .toLowerCase()
    .trim();

  if (raw.includes("bad gateway") || raw.includes("502")) {
    return "5xx";
  }

  if (raw.includes("operation was aborted")) {
    return "timeout";
  }

  const text = message.toLowerCase();

  if (statusCode === 429 || matchesAnyPattern(text, RATE_LIMIT_PATTERNS)) {
    return "rate_limit";
  }
  if (statusCode === 402 || matchesAnyPattern(text, QUOTA_PATTERNS)) {
    return "quota_exceeded";
  }
  if (statusCode === 529 || matchesAnyPattern(text, OVERLOADED_PATTERNS)) {
    return "overloaded";
  }
  if (matchesAnyPattern(text, TIMEOUT_PATTERNS)) {
    return "timeout";
  }
  if (
    (statusCode !== undefined && statusCode >= 500) ||
    matchesAnyPattern(text, SERVER_ERROR_PATTERNS)
  ) {
    return "5xx";
  }
  return "unknown";
}
