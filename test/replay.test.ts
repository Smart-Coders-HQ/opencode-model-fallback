import { describe, expect, it } from "bun:test";
import type { Part } from "@opencode-ai/sdk";
import { convertPartsForPrompt } from "../src/replay/message-converter.js";

describe("convertPartsForPrompt", () => {
  it("converts text parts", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "hello world",
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "hello world" });
  });

  it("filters out synthetic text parts", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "synthetic content",
        synthetic: true,
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(0);
  });

  it("filters out ignored text parts", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "ignored content",
        ignored: true,
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(0);
  });

  it("converts file parts", () => {
    const parts: Part[] = [
      {
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,abc",
        filename: "test.png",
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "file", mime: "image/png" });
  });

  it("converts agent parts", () => {
    const parts: Part[] = [
      {
        id: "p3",
        sessionID: "s1",
        messageID: "m1",
        type: "agent",
        name: "coder",
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "agent", name: "coder" });
  });

  it("filters out server-generated part types", () => {
    const parts: Part[] = [
      {
        id: "p4",
        sessionID: "s1",
        messageID: "m1",
        type: "reasoning",
        text: "thinking...",
        time: { start: Date.now() },
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(0);
  });

  it("handles mixed parts correctly", () => {
    const parts: Part[] = [
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "user message",
      },
      {
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "synthetic",
        synthetic: true,
      },
      {
        id: "p3",
        sessionID: "s1",
        messageID: "m1",
        type: "agent",
        name: "build",
      },
    ];
    const result = convertPartsForPrompt(parts);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "user message" });
    expect(result[1]).toEqual({ type: "agent", name: "build" });
  });
});
