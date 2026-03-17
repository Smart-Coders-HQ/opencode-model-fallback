import type { ErrorCategory } from "../types.js";
import { matchesAnyPattern } from "./patterns.js";

const RATE_LIMIT_PATTERNS = [
  "rate limit", "ratelimit", "too many requests", "usage limit", "429",
];

const QUOTA_PATTERNS = [
  "quota exceeded", "credits exhausted", "billing limit", "credit limit",
  "insufficient quota", "out of credits",
];

const OVERLOADED_PATTERNS = [
  "overloaded", "capacity exceeded", "server is busy", "engine is currently overloaded",
];

const TIMEOUT_PATTERNS = [
  "timeout", "timed out", "request timeout", "connection timeout",
];

const SERVER_ERROR_PATTERNS = [
  "internal server error", "bad gateway", "service unavailable",
  "gateway timeout", "500", "502", "503", "504",
];

export function classifyError(
  message: string,
  statusCode?: number
): ErrorCategory {
  const text = message.toLowerCase();

  if (statusCode === 429 || matchesAnyPattern(text, RATE_LIMIT_PATTERNS)) {
    return "rate_limit";
  }
  if (matchesAnyPattern(text, QUOTA_PATTERNS)) {
    return "quota_exceeded";
  }
  if (matchesAnyPattern(text, OVERLOADED_PATTERNS)) {
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
