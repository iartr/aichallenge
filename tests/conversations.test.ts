import { describe, expect, it } from "vitest";
import { buildConversationTitle, normalizeStoredMessages } from "../lib/conversations";

describe("conversation persistence helpers", () => {
  it("builds compact titles from the first user message", () => {
    expect(buildConversationTitle("  Remember   my city is Lisbon  ")).toBe("Remember my city is Lisbon");
    expect(buildConversationTitle("a".repeat(60))).toBe(`${"a".repeat(49)}...`);
    expect(buildConversationTitle("   ")).toBe("New chat");
  });

  it("keeps only valid stored chat messages", () => {
    expect(
      normalizeStoredMessages([
        {
          role: "user",
          content: " Hello ",
          usage: {
            tokens: 2,
            currentRequestTokens: 2,
            historyTokens: 10,
            responseTokens: 4,
            totalTokens: 14,
            contextWindowTokens: 100,
            remainingContextTokens: 86,
            estimatedCostUsd: 0.00001,
            failureMode: null,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            isEstimate: false,
          },
        },
        {
          role: "system",
          content: "Drop me",
        },
        {
          role: "assistant",
          content: " Hi ",
        },
        {
          role: "user",
          content: "",
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: "Hello",
        usage: {
          tokens: 2,
          currentRequestTokens: 2,
          historyTokens: 10,
          responseTokens: 4,
          totalTokens: 14,
          contextWindowTokens: 100,
          remainingContextTokens: 86,
          estimatedCostUsd: 0.00001,
          failureMode: null,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          isEstimate: false,
        },
      },
      {
        role: "assistant",
        content: "Hi",
      },
    ]);
  });
});
