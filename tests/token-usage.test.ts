import { describe, expect, it, vi } from "vitest";
import {
  applyProviderUsage,
  buildTokenUsageEstimate,
  countTextTokens,
  estimateTokenCostUsd,
  getContextWindowTokens,
  markTokenFailure,
  readOpenAIProviderUsage,
} from "../lib/token-usage";

describe("token usage helpers", () => {
  it("counts text tokens with the OpenAI o200k tokenizer", () => {
    expect(countTextTokens("Hello world")).toBeGreaterThan(0);
    expect(countTextTokens("Hello world. Add more words.")).toBeGreaterThan(countTextTokens("Hello world"));
  });

  it("estimates GPT-5.4 mini token cost from input, cached input, and output tokens", () => {
    expect(
      estimateTokenCostUsd({
        model: "gpt-5.4-mini-2026-03-17",
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(5.1825);
  });

  it("allows context window override for overflow demos", () => {
    vi.stubEnv("OPENAI_CONTEXT_WINDOW_TOKENS", "128");

    expect(getContextWindowTokens("gpt-5.4-mini-2026-03-17")).toBe(128);
    vi.unstubAllEnvs();
  });

  it("builds prompt, response, and remaining context estimates", () => {
    const usage = buildTokenUsageEstimate({
      model: "gpt-5.4-mini-2026-03-17",
      instructions: "Answer briefly.",
      maxOutputTokens: 100,
      responseText: "Done.",
      messages: [
        {
          role: "user",
          content: "Short question",
        },
      ],
    });

    expect(usage.currentRequestTokens).toBeGreaterThan(0);
    expect(usage.historyTokens).toBeGreaterThan(usage.currentRequestTokens);
    expect(usage.responseTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.historyTokens + usage.responseTokens);
    expect(usage.remainingContextTokens).toBeGreaterThan(0);
  });

  it("reads OpenAI Responses usage shape", () => {
    expect(
      readOpenAIProviderUsage({
        usage: {
          input_tokens: 20,
          input_tokens_details: {
            cached_tokens: 4,
          },
          output_tokens: 5,
          output_tokens_details: {
            reasoning_tokens: 2,
          },
          total_tokens: 25,
        },
      }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
  });

  it("applies provider usage and marks overflow failures", () => {
    const estimate = buildTokenUsageEstimate({
      model: "gpt-5.4-mini-2026-03-17",
      instructions: "Answer briefly.",
      maxOutputTokens: 100,
      messages: [
        {
          role: "user",
          content: "Short question",
        },
      ],
    });
    const usage = applyProviderUsage(
      estimate,
      {
        inputTokens: 30,
        outputTokens: 8,
        totalTokens: 38,
        cachedInputTokens: 5,
        reasoningTokens: 1,
      },
      "gpt-5.4-mini-2026-03-17",
    );

    expect(usage).toMatchObject({
      historyTokens: 30,
      responseTokens: 8,
      totalTokens: 38,
      cachedInputTokens: 5,
      reasoningTokens: 1,
      isEstimate: false,
    });
    expect(markTokenFailure(usage, "preflight_context_overflow").failureMode).toBe("preflight_context_overflow");
  });
});
