import { describe, expect, it, vi } from "vitest";
import { CHAT_AGENT_INSTRUCTIONS, ChatAgentError, type AgentChatMessage } from "../lib/chat-agent";
import {
  CONTEXT_STRATEGIES,
  DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
  FACTS_EXTRACTOR_INSTRUCTIONS,
  addFactsUsage,
  applySlidingWindow,
  buildFactsInstructions,
  buildFactsStep,
  buildStrategyReport,
  coerceFactValue,
  emptyFactsUsageTotals,
  extractFacts,
  normalizeContextStrategy,
  normalizeFacts,
  normalizeFactsState,
  normalizeFactsUsage,
  normalizeWindowSize,
  parseFactsJson,
  type FactItem,
  type FactsExtractorResult,
} from "../lib/context-strategies";
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

describe("normalizeContextStrategy / normalizeWindowSize", () => {
  it("accepts known strategies and falls back to full", () => {
    for (const strategy of CONTEXT_STRATEGIES) {
      expect(normalizeContextStrategy(strategy)).toBe(strategy);
    }

    expect(normalizeContextStrategy("nope")).toBe("full");
    expect(normalizeContextStrategy(null)).toBe("full");
  });

  it("clamps the window size to a positive integer", () => {
    expect(normalizeWindowSize(8)).toBe(8);
    expect(normalizeWindowSize(0)).toBe(1);
    expect(normalizeWindowSize(-4)).toBe(1);
    expect(normalizeWindowSize(3.9)).toBe(3);
    expect(normalizeWindowSize("bad", 6)).toBe(6);
  });
});

describe("applySlidingWindow", () => {
  it("keeps only the last N messages", () => {
    const messages = makeMessages(10);

    expect(applySlidingWindow(messages, 3)).toEqual(messages.slice(7));
  });

  it("is a no-op when the window is larger than the history", () => {
    const messages = makeMessages(4);

    expect(applySlidingWindow(messages, 10)).toBe(messages);
    expect(applySlidingWindow(messages, 4)).toBe(messages);
  });

  it("clamps a window below 1 to a single message and keeps the last user message last", () => {
    const messages = makeMessages(5); // index 4 is a user message

    expect(applySlidingWindow(messages, 0)).toEqual([messages[4]]);
    expect(applySlidingWindow(messages, -3)).toEqual([messages[4]]);
    expect(applySlidingWindow(messages, 2).at(-1)).toBe(messages[4]);
  });
});

describe("buildFactsInstructions", () => {
  it("returns base instructions unchanged when there are no facts", () => {
    expect(buildFactsInstructions(CHAT_AGENT_INSTRUCTIONS, [])).toBe(CHAT_AGENT_INSTRUCTIONS);
    expect(buildFactsInstructions(CHAT_AGENT_INSTRUCTIONS, [{ key: "goal", value: "  " }])).toBe(
      CHAT_AGENT_INSTRUCTIONS,
    );
  });

  it("appends a labelled key-value block", () => {
    const instructions = buildFactsInstructions(CHAT_AGENT_INSTRUCTIONS, [
      { key: "goal", value: "Ship a landing page" },
      { key: "constraints", value: "Budget 1500 EUR; deadline Aug 1" },
    ]);

    expect(instructions).toContain(CHAT_AGENT_INSTRUCTIONS);
    expect(instructions).toContain("Known facts about this conversation");
    expect(instructions).toContain("- goal: Ship a landing page");
    expect(instructions).toContain("- constraints: Budget 1500 EUR; deadline Aug 1");
  });
});

describe("coerceFactValue / parseFactsJson", () => {
  it("coerces strings, arrays, and primitives", () => {
    expect(coerceFactValue("  hi  ")).toBe("hi");
    expect(coerceFactValue(["a", " b ", 3])).toBe("a; b");
    expect(coerceFactValue(17)).toBe("17");
    expect(coerceFactValue({})).toBe("");
  });

  it("parses a clean JSON object into ordered fact items", () => {
    const facts = parseFactsJson('{"goal":"Landing page","constraints":"Budget 1500"}');

    expect(facts).toEqual([
      { key: "goal", value: "Landing page" },
      { key: "constraints", value: "Budget 1500" },
    ]);
  });

  it("parses JSON wrapped in code fences and trailing prose", () => {
    const facts = parseFactsJson('Here:\n```json\n{"goal":"X"}\n```\nthanks');

    expect(facts).toEqual([{ key: "goal", value: "X" }]);
  });

  it("joins array values and drops unknown keys", () => {
    const facts = parseFactsJson('{"preferences":["dark theme","fast"],"random":"drop"}');

    expect(facts).toEqual([{ key: "preferences", value: "dark theme; fast" }]);
  });

  it("returns the previous facts when the text is not parseable", () => {
    const previous: FactItem[] = [{ key: "goal", value: "keep me" }];

    expect(parseFactsJson("not json at all", previous)).toEqual(previous);
    expect(parseFactsJson('{"goal":""}', previous)).toEqual(previous);
  });
});

describe("facts usage totals", () => {
  it("normalizes malformed jsonb to zeros", () => {
    expect(normalizeFactsUsage(null)).toEqual(emptyFactsUsageTotals());
    expect(normalizeFactsUsage("garbage")).toEqual(emptyFactsUsageTotals());
    expect(normalizeFactsUsage({ calls: -2, totalTokens: "9" })).toMatchObject({ calls: 0, totalTokens: 9 });
  });

  it("accumulates usage", () => {
    const totals = addFactsUsage(
      emptyFactsUsageTotals(),
      makeUsage({ historyTokens: 80, responseTokens: 20, totalTokens: 100, estimatedCostUsd: 0.0001 }),
    );

    expect(totals).toEqual({ calls: 1, inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: 0.0001 });
  });
});

describe("normalizeFacts / normalizeFactsState", () => {
  it("reads facts from an items array and skips invalid entries", () => {
    const value = {
      items: [
        { key: "goal", value: "X" },
        { key: "unknown", value: "drop" },
        { key: "constraints", value: "" },
        { key: "decisions", value: "Use Next.js" },
      ],
      coveredCount: 4,
      usage: { calls: 2 },
    };

    expect(normalizeFacts(value)).toEqual([
      { key: "goal", value: "X" },
      { key: "decisions", value: "Use Next.js" },
    ]);
    expect(normalizeFactsState(value)).toEqual({
      facts: [
        { key: "goal", value: "X" },
        { key: "decisions", value: "Use Next.js" },
      ],
      factsCoveredCount: 4,
    });
  });

  it("tolerates the empty jsonb default", () => {
    expect(normalizeFacts({})).toEqual([]);
    expect(normalizeFactsState({})).toEqual({ facts: [], factsCoveredCount: 0 });
  });
});

describe("buildFactsStep", () => {
  it("extracts first, then sends the facts block plus the windowed tail", async () => {
    const messages = makeMessages(10);
    const extract = vi.fn(
      async (): Promise<FactsExtractorResult> => ({
        facts: [{ key: "goal", value: "Landing page" }],
        usage: makeUsage(),
        model: "gpt-test",
      }),
    );

    const step = await buildFactsStep(messages, { facts: [], factsCoveredCount: 0 }, extract, { windowSize: 4 });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith({ previousFacts: [], messages });
    expect(step.state).toEqual({ facts: [{ key: "goal", value: "Landing page" }], factsCoveredCount: 10 });
    expect(step.sentMessages).toEqual(messages.slice(6));
    expect(step.instructions).toContain("- goal: Landing page");
    expect(step.factsUsage).toEqual(makeUsage());
    expect(step.factsError).toBeNull();
  });

  it("only folds the uncovered tail on later turns", async () => {
    const messages = makeMessages(6);
    const extract = vi.fn(
      async (): Promise<FactsExtractorResult> => ({ facts: [], usage: makeUsage(), model: "gpt-test" }),
    );

    await buildFactsStep(messages, { facts: [], factsCoveredCount: 3 }, extract, { windowSize: 2 });

    expect(extract).toHaveBeenCalledWith({ previousFacts: [], messages: messages.slice(3) });
  });

  it("degrades gracefully when the extractor throws", async () => {
    const messages = makeMessages(5);
    const previous: FactItem[] = [{ key: "goal", value: "keep" }];
    const extract = vi.fn(async () => {
      throw new ChatAgentError("Extractor unavailable.", 502);
    });

    const step = await buildFactsStep(messages, { facts: previous, factsCoveredCount: 0 }, extract, {
      windowSize: 2,
    });

    expect(step.state).toEqual({ facts: previous, factsCoveredCount: 0 });
    expect(step.sentMessages).toEqual(messages.slice(3));
    expect(step.instructions).toContain("- goal: keep");
    expect(step.factsError).toBe("Extractor unavailable.");
  });
});

describe("extractFacts", () => {
  it("sends the extractor instructions and parses the K/V JSON", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: '{"goal":"Landing page","constraints":"Budget 1500"}',
            usage: { input_tokens: 60, output_tokens: 25, total_tokens: 85 },
          }),
          { status: 200 },
        ),
    );

    const result = await extractFacts({
      apiKey: "openai-key",
      previousFacts: [{ key: "goal", value: "old" }],
      messages: [{ role: "user", content: "Budget is 1500 EUR." }],
      model: "gpt-facts-test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));

    expect(payload.model).toBe("gpt-facts-test");
    expect(payload.instructions).toBe(FACTS_EXTRACTOR_INSTRUCTIONS);
    expect(payload.max_output_tokens).toBe(DEFAULT_FACTS_MAX_OUTPUT_TOKENS);
    expect(payload.input[0].content[0].text).toContain('Current facts (JSON):\n{"goal":"old"}');
    expect(payload.input[0].content[0].text).toContain("user: Budget is 1500 EUR.");
    expect(result.facts).toEqual([
      { key: "goal", value: "Landing page" },
      { key: "constraints", value: "Budget 1500" },
    ]);
    expect(result.usage.totalTokens).toBe(85);
  });

  it("keeps previous facts when the model returns non-JSON", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "sure, noted!" }), { status: 200 }));
    const previous: FactItem[] = [{ key: "goal", value: "keep" }];

    const result = await extractFacts({
      apiKey: "openai-key",
      previousFacts: previous,
      messages: [{ role: "user", content: "ok" }],
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result.facts).toEqual(previous);
  });

  it("resolves the model from OPENAI_FACTS_MODEL", async () => {
    vi.stubEnv("OPENAI_FACTS_MODEL", "gpt-env-facts");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "{}" }), { status: 200 }));

    const result = await extractFacts({
      apiKey: "openai-key",
      previousFacts: [],
      messages: [{ role: "user", content: "hi" }],
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result.model).toBe("gpt-env-facts");
    vi.unstubAllEnvs();
  });

  it("propagates provider errors as ChatAgentError", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "Rate limited." } }), { status: 429 }),
    );

    await expect(
      extractFacts({
        apiKey: "openai-key",
        previousFacts: [],
        messages: [{ role: "user", content: "hi" }],
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Rate limited.");
  });
});

describe("buildStrategyReport", () => {
  it("reports sliding-window savings and dropped messages", () => {
    const allMessages = makeMessages(10);
    const sentMessages = allMessages.slice(7);

    const report = buildStrategyReport({
      strategy: "sliding_window",
      windowSize: 3,
      allMessages,
      sentMessages,
      instructions: CHAT_AGENT_INSTRUCTIONS,
    });

    expect(report.enabled).toBe(true);
    expect(report.sentMessageCount).toBe(3);
    expect(report.droppedMessageCount).toBe(7);
    expect(report.sentHistoryTokens).toBe(countHistoryTokens(sentMessages, CHAT_AGENT_INSTRUCTIONS));
    expect(report.fullHistoryTokens).toBe(countHistoryTokens(allMessages, CHAT_AGENT_INSTRUCTIONS));
    expect(report.savedTokens).toBe(report.fullHistoryTokens - report.sentHistoryTokens);
    expect(report.savedPercent).toBeGreaterThan(0);
    expect(report.extraTokens).toBe(0);
  });

  it("counts the facts block as extra tokens", () => {
    const allMessages = makeMessages(8);
    const sentMessages = allMessages.slice(6);
    const facts: FactItem[] = [{ key: "goal", value: "Landing page for a coffee shop" }];
    const instructions = buildFactsInstructions(CHAT_AGENT_INSTRUCTIONS, facts);

    const report = buildStrategyReport({
      strategy: "facts",
      windowSize: 2,
      allMessages,
      sentMessages,
      instructions,
      facts,
      helperUsage: makeUsage(),
    });

    expect(report.extraTokens).toBeGreaterThan(0);
    expect(report.factsTokens).toBeGreaterThan(0);
    expect(report.facts).toEqual(facts);
    expect(report.helperUsage?.calls).toBe(1);
  });

  it("reports no savings for the full strategy", () => {
    const allMessages = makeMessages(6);

    const report = buildStrategyReport({
      strategy: "full",
      allMessages,
      sentMessages: allMessages,
      instructions: CHAT_AGENT_INSTRUCTIONS,
    });

    expect(report.enabled).toBe(false);
    expect(report.savedTokens).toBe(0);
    expect(report.droppedMessageCount).toBe(0);
  });
});
