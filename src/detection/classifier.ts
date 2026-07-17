import type { ErrorCategory } from "../types.js";
import { matchesAnyPattern } from "./patterns.js";

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "ratelimit",
  "too many requests",
  "usage limit",
  "resource exhausted",
  "resource_exhausted",
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
];

const UNAUTHORIZED_PATTERNS = [
  "unauthorized",
  "authentication required",
  "invalid api key",
  "access denied",
];

const LIMIT_PATTERNS = [
  "limit reached",
  "usage limit exceeded",
  "request limit",
];

const INSUFFICIENT_CREDITS_PATTERNS = [
  "insufficient credits",
  "insufficient credit",
  "no credits",
];

const INSUFFICIENT_BALANCE_PATTERNS = [
  "insufficient balance",
  "insufficient funds",
  "balance too low",
  "account balance",
];

const PREMIUM_PATTERNS = [
  "premium subscription",
  "premium required",
  "subscription required",
  "paid subscription",
];

const PAYMENT_PATTERNS = [
  "payment required",
  "billing required",
  "upgrade required",
];

const CREDIT_BALANCE_PATTERNS = [
  "credit balance",
  "credit too low",
  "credit usage",
];

const BILLING_PATTERNS = [
  "billing error",
  "billing issue",
  "billing problem",
];

export function classifyError(message: string, statusCode?: number): ErrorCategory {
  const text = message.toLowerCase();

  // Status code based classification (preserves original behavior)
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 402) return "quota_exceeded";
  if (statusCode === 529) return "overloaded";
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "unauthorized";

  // Message pattern based classification
  if (matchesAnyPattern(text, UNAUTHORIZED_PATTERNS)) return "unauthorized";
  if (matchesAnyPattern(text, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchesAnyPattern(text, QUOTA_PATTERNS)) return "quota_exceeded";
  if (matchesAnyPattern(text, INSUFFICIENT_CREDITS_PATTERNS)) return "insufficient_credits";
  if (matchesAnyPattern(text, INSUFFICIENT_BALANCE_PATTERNS)) return "insufficient_balance";
  if (matchesAnyPattern(text, PREMIUM_PATTERNS)) return "premium";
  if (matchesAnyPattern(text, PAYMENT_PATTERNS)) return "payment_required";
  if (matchesAnyPattern(text, CREDIT_BALANCE_PATTERNS)) return "credit_balance";
  if (matchesAnyPattern(text, BILLING_PATTERNS)) return "billing";
  if (matchesAnyPattern(text, LIMIT_PATTERNS)) return "limit";
  if (matchesAnyPattern(text, OVERLOADED_PATTERNS)) return "overloaded";
  if (matchesAnyPattern(text, TIMEOUT_PATTERNS)) return "timeout";
  if (matchesAnyPattern(text, SERVER_ERROR_PATTERNS)) return "5xx";

  // Generic status code ranges
  if (statusCode !== undefined && statusCode >= 500) return "5xx";

  return "unknown";
}
