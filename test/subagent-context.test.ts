import { describe, expect, it } from "bun:test";
import {
  captureSubagentContext,
  snapshotsToPromptParts,
} from "../src/replay/subagent-context.js";
import type { Logger } from "../src/logging/logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("captureSubagentContext", () => {
  it("captures subagent messages after last user message", () => {
    const messages = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      {
        info: { role: "assistant", id: "a1", agent: "coder" },
        parts: [{ type: "text", text: "coder result" }],
      },
      {
        info: { role: "assistant", id: "a2", agent: "reviewer" },
        parts: [{ type: "text", text: "reviewer result" }],
      },
    ];

    const snapshots = captureSubagentContext(messages, "u1", "architect", noopLogger);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].agentName).toBe("coder");
    expect(snapshots[0].parts[0]).toEqual({ type: "text", text: "coder result" });
    expect(snapshots[1].agentName).toBe("reviewer");
  });

  it("skips messages from primary agent", () => {
    const messages = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      {
        info: { role: "assistant", id: "a1", agent: "architect" },
        parts: [{ type: "text", text: "architect output" }],
      },
      {
        info: { role: "assistant", id: "a2", agent: "coder" },
        parts: [{ type: "text", text: "coder output" }],
      },
    ];

    const snapshots = captureSubagentContext(messages, "u1", "architect", noopLogger);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].agentName).toBe("coder");
  });

  it("returns empty when no subagent messages exist", () => {
    const messages = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      {
        info: { role: "assistant", id: "a1", agent: "architect" },
        parts: [{ type: "text", text: "architect output" }],
      },
    ];

    const snapshots = captureSubagentContext(messages, "u1", "architect", noopLogger);

    expect(snapshots).toHaveLength(0);
  });

  it("skips messages without text parts", () => {
    const messages = [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "hello" }] },
      {
        info: { role: "assistant", id: "a1", agent: "coder" },
        parts: [{ type: "tool_use", name: "write", input: {} }],
      },
    ];

    const snapshots = captureSubagentContext(messages, "u1", "architect", noopLogger);

    expect(snapshots).toHaveLength(0);
  });

  it("does not capture messages before the last user message", () => {
    const messages = [
      { info: { role: "user", id: "u0" }, parts: [{ type: "text", text: "first" }] },
      {
        info: { role: "assistant", id: "a0", agent: "coder" },
        parts: [{ type: "text", text: "old coder result" }],
      },
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "second" }] },
      {
        info: { role: "assistant", id: "a1", agent: "coder" },
        parts: [{ type: "text", text: "new coder result" }],
      },
    ];

    const snapshots = captureSubagentContext(messages, "u1", "architect", noopLogger);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].messageId).toBe("a1");
  });
});

describe("snapshotsToPromptParts", () => {
  it("converts snapshots to prompt parts with context markers", () => {
    const snapshots = [
      {
        agentName: "coder",
        parts: [{ type: "text" as const, text: "code result" }],
        messageId: "a1",
      },
    ];

    const parts = snapshotsToPromptParts(snapshots);

    expect(parts).toHaveLength(3);
    expect(parts[0].text).toContain("CONTEXT PRESERVED");
    expect(parts[1].text).toContain("coder");
    expect(parts[1].text).toContain("code result");
    expect(parts[2].text).toContain("END PRESERVED CONTEXT");
  });

  it("returns empty array for no snapshots", () => {
    const parts = snapshotsToPromptParts([]);
    expect(parts).toHaveLength(0);
  });

  it("includes all subagent results in order", () => {
    const snapshots = [
      {
        agentName: "coder",
        parts: [{ type: "text" as const, text: "code" }],
        messageId: "a1",
      },
      {
        agentName: "reviewer",
        parts: [{ type: "text" as const, text: "review" }],
        messageId: "a2",
      },
    ];

    const parts = snapshotsToPromptParts(snapshots);

    expect(parts).toHaveLength(4);
    expect(parts[1].text).toContain("[Subagent: coder]");
    expect(parts[2].text).toContain("[Subagent: reviewer]");
  });
});
