import { describe, expect, it } from "bun:test";
import { classifyError } from "../src/detection/classifier.js";
import { matchesAnyPattern } from "../src/detection/patterns.js";

describe("classifyError", () => {
  it("classifies 429 status code as rate_limit", () => {
    expect(classifyError("some error", 429)).toBe("rate_limit");
  });

  it("classifies rate limit message", () => {
    expect(classifyError("Rate limit exceeded for model")).toBe("rate_limit");
    expect(classifyError("Too many requests")).toBe("rate_limit");
    expect(classifyError("usage limit reached")).toBe("rate_limit");
    expect(classifyError("429 Too Many Requests")).toBe("rate_limit");
  });

  it("classifies quota exceeded", () => {
    expect(classifyError("Quota exceeded for your account")).toBe("quota_exceeded");
    expect(classifyError("Credits exhausted")).toBe("quota_exceeded");
    expect(classifyError("Billing limit reached")).toBe("quota_exceeded");
  });

  it("classifies overloaded", () => {
    expect(classifyError("The engine is currently overloaded")).toBe("overloaded");
    expect(classifyError("Server is busy")).toBe("overloaded");
    expect(classifyError("capacity exceeded")).toBe("overloaded");
  });

  it("classifies timeout", () => {
    expect(classifyError("Request timed out")).toBe("timeout");
    expect(classifyError("Connection timeout")).toBe("timeout");
  });

  it("classifies 5xx status codes", () => {
    expect(classifyError("Internal server error", 500)).toBe("5xx");
    expect(classifyError("Bad Gateway", 502)).toBe("5xx");
    expect(classifyError("Service Unavailable", 503)).toBe("5xx");
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyError("Something went completely wrong")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyError("RATE LIMIT EXCEEDED")).toBe("rate_limit");
    expect(classifyError("Rate Limit Exceeded")).toBe("rate_limit");
  });
});

describe("matchesAnyPattern", () => {
  const patterns = ["rate limit", "quota exceeded", "429"];

  it("matches pattern in message", () => {
    expect(matchesAnyPattern("You have hit a rate limit", patterns)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesAnyPattern("RATE LIMIT hit", patterns)).toBe(true);
  });

  it("returns false for no match", () => {
    expect(matchesAnyPattern("Connection refused", patterns)).toBe(false);
  });

  it("matches substring", () => {
    expect(matchesAnyPattern("Error: 429 Too Many Requests", patterns)).toBe(true);
  });
});
