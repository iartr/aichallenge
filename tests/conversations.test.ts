import { describe, expect, it } from "vitest";
import { buildConversationTitle, extensionStateFromRecord, normalizeStoredMessages } from "../lib/conversations";
import { emptyFactsUsageTotals } from "../lib/context-strategies";
import { initBranchingState } from "../lib/branching";
import { emptySummarizerUsageTotals } from "../lib/history-compression";

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

  it("extracts a pass-through update payload from a loaded record", () => {
    const branches = initBranchingState([{ role: "user", content: "hi" }]);
    const state = extensionStateFromRecord({
      id: "id-1",
      title: "T",
      messageCount: 1,
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
      messages: [{ role: "user", content: "hi" }],
      summary: "Earlier facts.",
      summaryCoveredCount: 2,
      summarizerUsage: emptySummarizerUsageTotals(),
      contextStrategy: "facts",
      facts: [{ key: "goal", value: "X" }],
      factsState: { facts: [{ key: "goal", value: "X" }], factsCoveredCount: 3 },
      factsUsage: emptyFactsUsageTotals(),
      branches,
    });

    expect(state).toEqual({
      summary: "Earlier facts.",
      summaryCoveredCount: 2,
      summarizerUsage: emptySummarizerUsageTotals(),
      contextStrategy: "facts",
      facts: { facts: [{ key: "goal", value: "X" }], factsCoveredCount: 3 },
      factsUsage: emptyFactsUsageTotals(),
      branches,
    });
  });
});
