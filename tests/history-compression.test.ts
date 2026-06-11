import { describe, expect, it, vi } from "vitest";
import { CHAT_AGENT_INSTRUCTIONS, ChatAgentError, type AgentChatMessage } from "../lib/chat-agent";
import {
  DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
  KEEP_RECENT_MESSAGES,
  SUMMARIZER_INSTRUCTIONS,
  SUMMARY_BATCH_SIZE,
  addSummarizerUsage,
  buildCompressedInstructions,
  buildCompressionReport,
  buildSummarizerInput,
  compressHistory,
  emptySummarizerUsageTotals,
  normalizeSummarizerUsage,
  planCompression,
  summarizeMessages,
  type SummarizerResult,
} from "../lib/history-compression";
import { countHistoryTokens, type AgentTokenUsage } from "../lib/token-usage";

function makeMessages(count: number): AgentChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${index + 1}`,
  }));
}

function makeUsage(overrides: Partial<AgentTokenUsage> = {}): AgentTokenUsage {
  return {
    currentRequestTokens: 10,
    historyTokens: 100,
    responseTokens: 40,
    totalTokens: 140,
    contextWindowTokens: 1_000_000,
    remainingContextTokens: 999_860,
    estimatedCostUsd: 0.00025,
    failureMode: null,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    isEstimate: false,
    ...overrides,
  };
}

describe("planCompression", () => {
  it("does not fold while the uncovered tail is below keep + batch", () => {
    const plan = planCompression(makeMessages(19), { summary: "", summaryCoveredCount: 0 });

    expect(plan.foldCount).toBe(0);
    expect(plan.messagesToFold).toEqual([]);
  });

  it("folds one batch when the uncovered tail reaches keep + batch", () => {
    const messages = makeMessages(21);
    const plan = planCompression(messages, { summary: "", summaryCoveredCount: 0 });

    expect(plan.foldCount).toBe(SUMMARY_BATCH_SIZE);
    expect(plan.messagesToFold).toEqual(messages.slice(0, 10));
  });

  it("folds multiple batches at once to catch up after compression was off", () => {
    const messages = makeMessages(31);
    const plan = planCompression(messages, { summary: "", summaryCoveredCount: 0 });

    expect(plan.foldCount).toBe(20);
    expect(plan.messagesToFold).toEqual(messages.slice(0, 20));
  });

  it("folds the next batch relative to already covered messages", () => {
    const messages = makeMessages(31);
    const plan = planCompression(messages, { summary: "Earlier facts.", summaryCoveredCount: 10 });

    expect(plan.foldCount).toBe(SUMMARY_BATCH_SIZE);
    expect(plan.messagesToFold).toEqual(messages.slice(10, 20));
  });

  it("keeps at least the last N messages uncovered", () => {
    const messages = makeMessages(25);
    const plan = planCompression(messages, { summary: "", summaryCoveredCount: 0 });

    expect(messages.length - plan.foldCount).toBeGreaterThanOrEqual(KEEP_RECENT_MESSAGES);
  });

  it("clamps a covered count larger than the message list", () => {
    const plan = planCompression(makeMessages(5), { summary: "Old.", summaryCoveredCount: 50 });

    expect(plan.foldCount).toBe(0);
    expect(plan.messagesToFold).toEqual([]);
  });
});

describe("buildCompressedInstructions", () => {
  it("returns base instructions unchanged when summary is empty", () => {
    expect(buildCompressedInstructions(CHAT_AGENT_INSTRUCTIONS, "")).toBe(CHAT_AGENT_INSTRUCTIONS);
    expect(buildCompressedInstructions(CHAT_AGENT_INSTRUCTIONS, "   ")).toBe(CHAT_AGENT_INSTRUCTIONS);
  });

  it("appends the summary to the base instructions", () => {
    const instructions = buildCompressedInstructions(CHAT_AGENT_INSTRUCTIONS, "User's name is Art.");

    expect(instructions).toContain(CHAT_AGENT_INSTRUCTIONS);
    expect(instructions).toContain("User's name is Art.");
    expect(instructions).toContain("Summary of the earlier part of this conversation");
  });
});

describe("buildSummarizerInput", () => {
  it("marks a missing previous summary and prefixes message roles", () => {
    const input = buildSummarizerInput("", [
      { role: "user", content: "My name is Art." },
      { role: "assistant", content: "Nice to meet you." },
    ]);

    expect(input).toContain("Previous summary:\n(none)");
    expect(input).toContain("user: My name is Art.");
    expect(input).toContain("assistant: Nice to meet you.");
  });

  it("embeds the previous summary", () => {
    expect(buildSummarizerInput("Art lives in Lisbon.", [{ role: "user", content: "Ok." }])).toContain(
      "Previous summary:\nArt lives in Lisbon.",
    );
  });
});

describe("compressHistory", () => {
  it("folds the oldest batch and sends the remaining tail with summary instructions", async () => {
    const messages = makeMessages(21);
    const summarize = vi.fn(
      async (): Promise<SummarizerResult> => ({
        summary: "Folded summary.",
        usage: makeUsage(),
        model: "gpt-test",
      }),
    );

    const step = await compressHistory(messages, { summary: "", summaryCoveredCount: 0 }, summarize);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith({
      previousSummary: "",
      messages: messages.slice(0, 10),
    });
    expect(step.state).toEqual({ summary: "Folded summary.", summaryCoveredCount: 10 });
    expect(step.sentMessages).toEqual(messages.slice(10));
    expect(step.instructions).toContain("Folded summary.");
    expect(step.summarizerUsage).toEqual(makeUsage());
    expect(step.summarizerError).toBeNull();
  });

  it("skips the summarizer when no fold is needed and keeps existing summary in instructions", async () => {
    const messages = makeMessages(15);
    const summarize = vi.fn();

    const step = await compressHistory(
      messages,
      { summary: "Known facts.", summaryCoveredCount: 4 },
      summarize as never,
    );

    expect(summarize).not.toHaveBeenCalled();
    expect(step.state).toEqual({ summary: "Known facts.", summaryCoveredCount: 4 });
    expect(step.sentMessages).toEqual(messages.slice(4));
    expect(step.instructions).toContain("Known facts.");
    expect(step.summarizerUsage).toBeNull();
  });

  it("uses base instructions when there is no summary and no fold", async () => {
    const messages = makeMessages(3);
    const step = await compressHistory(messages, { summary: "", summaryCoveredCount: 0 }, vi.fn() as never);

    expect(step.instructions).toBe(CHAT_AGENT_INSTRUCTIONS);
    expect(step.sentMessages).toEqual(messages);
  });

  it("degrades gracefully when the summarizer fails", async () => {
    const messages = makeMessages(21);
    const summarize = vi.fn(async () => {
      throw new ChatAgentError("Summarizer unavailable.", 502);
    });

    const step = await compressHistory(messages, { summary: "Old summary.", summaryCoveredCount: 0 }, summarize);

    expect(step.state).toEqual({ summary: "Old summary.", summaryCoveredCount: 0 });
    expect(step.sentMessages).toEqual(messages);
    expect(step.instructions).toContain("Old summary.");
    expect(step.summarizerUsage).toBeNull();
    expect(step.summarizerError).toBe("Summarizer unavailable.");
  });
});

describe("buildCompressionReport", () => {
  it("reports tiktoken savings of the compressed prompt against the full history", () => {
    const allMessages = makeMessages(21);
    const sentMessages = allMessages.slice(10);
    const instructions = buildCompressedInstructions(CHAT_AGENT_INSTRUCTIONS, "Short summary.");
    const summarizerUsage = makeUsage({ totalTokens: 150 });

    const report = buildCompressionReport({
      enabled: true,
      allMessages,
      sentMessages,
      instructions,
      state: { summary: "Short summary.", summaryCoveredCount: 10 },
      summarizerUsage,
      summarizerTotals: addSummarizerUsage(emptySummarizerUsageTotals(), summarizerUsage),
      summarizerError: null,
    });

    expect(report.sentHistoryTokens).toBe(countHistoryTokens(sentMessages, instructions));
    expect(report.fullHistoryTokens).toBe(countHistoryTokens(allMessages, CHAT_AGENT_INSTRUCTIONS));
    expect(report.savedTokens).toBe(report.fullHistoryTokens - report.sentHistoryTokens);
    expect(report.savedPercent).toBeGreaterThan(0);
    expect(report.coveredMessageCount).toBe(10);
    expect(report.sentMessageCount).toBe(11);
    expect(report.summaryTokens).toBeGreaterThan(0);
    expect(report.summarizer?.calls).toBe(1);
    expect(report.netSavedTokens).toBe(report.savedTokens - 150);
  });

  it("reports zero savings when compression is disabled", () => {
    const allMessages = makeMessages(21);

    const report = buildCompressionReport({
      enabled: false,
      allMessages,
      sentMessages: allMessages,
      instructions: CHAT_AGENT_INSTRUCTIONS,
      state: { summary: "", summaryCoveredCount: 0 },
      summarizerUsage: null,
      summarizerTotals: emptySummarizerUsageTotals(),
      summarizerError: null,
    });

    expect(report.enabled).toBe(false);
    expect(report.sentHistoryTokens).toBe(report.fullHistoryTokens);
    expect(report.savedTokens).toBe(0);
    expect(report.savedPercent).toBe(0);
    expect(report.summarizer).toBeNull();
    expect(report.summaryTokens).toBe(0);
  });
});

describe("summarizer usage totals", () => {
  it("normalizes empty or malformed jsonb values to zeroed totals", () => {
    expect(normalizeSummarizerUsage({})).toEqual(emptySummarizerUsageTotals());
    expect(normalizeSummarizerUsage(null)).toEqual(emptySummarizerUsageTotals());
    expect(normalizeSummarizerUsage("garbage")).toEqual(emptySummarizerUsageTotals());
    expect(normalizeSummarizerUsage({ calls: -3, totalTokens: "12" })).toMatchObject({
      calls: 0,
      totalTokens: 12,
    });
  });

  it("round-trips totals and accumulates usage", () => {
    const totals = addSummarizerUsage(
      emptySummarizerUsageTotals(),
      makeUsage({ historyTokens: 80, responseTokens: 20, totalTokens: 100, estimatedCostUsd: 0.0001 }),
    );

    expect(totals).toEqual({
      calls: 1,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      costUsd: 0.0001,
    });
    expect(normalizeSummarizerUsage(JSON.parse(JSON.stringify(totals)))).toEqual(totals);

    const next = addSummarizerUsage(
      totals,
      makeUsage({ historyTokens: 40, responseTokens: 10, totalTokens: 50, estimatedCostUsd: 0.0002 }),
    );

    expect(next).toEqual({
      calls: 2,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costUsd: 0.0003,
    });
  });
});

describe("summarizeMessages", () => {
  it("sends the summarizer instructions and a single user transcript message", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: "Merged summary.",
            usage: {
              input_tokens: 60,
              output_tokens: 25,
              total_tokens: 85,
            },
          }),
          { status: 200 },
        ),
    );

    const result = await summarizeMessages({
      apiKey: "openai-key",
      previousSummary: "Art lives in Lisbon.",
      messages: [
        { role: "user", content: "My cat is Busya." },
        { role: "assistant", content: "Noted." },
      ],
      model: "gpt-summary-test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const [, init] = fetcher.mock.calls[0];
    const payload = JSON.parse(String(init?.body));

    expect(payload.model).toBe("gpt-summary-test");
    expect(payload.instructions).toBe(SUMMARIZER_INSTRUCTIONS);
    expect(payload.max_output_tokens).toBe(DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS);
    expect(payload.input).toHaveLength(1);
    expect(payload.input[0].role).toBe("user");
    expect(payload.input[0].content[0].text).toContain("Previous summary:\nArt lives in Lisbon.");
    expect(payload.input[0].content[0].text).toContain("user: My cat is Busya.");
    expect(result.summary).toBe("Merged summary.");
    expect(result.usage.totalTokens).toBe(85);
    expect(result.model).toBe("gpt-summary-test");
  });

  it("resolves the model from OPENAI_SUMMARY_MODEL when not passed", async () => {
    vi.stubEnv("OPENAI_SUMMARY_MODEL", "gpt-env-summary");

    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Summary." }), { status: 200 }));
    const result = await summarizeMessages({
      apiKey: "openai-key",
      previousSummary: "",
      messages: [{ role: "user", content: "Hi." }],
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result.model).toBe("gpt-env-summary");
    vi.unstubAllEnvs();
  });

  it("propagates provider errors as ChatAgentError", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "Rate limited." } }), { status: 429 }),
    );

    await expect(
      summarizeMessages({
        apiKey: "openai-key",
        previousSummary: "",
        messages: [{ role: "user", content: "Hi." }],
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Rate limited.");
  });
});
