import { describe, expect, it, vi } from "vitest";
import {
  CHAT_AGENT_INSTRUCTIONS,
  DEFAULT_OPENAI_CHAT_MODEL,
  OPENAI_CHAT_RESPONSES_URL,
  OpenAIChatAgent,
  buildOpenAIChatPayload,
  extractOpenAIText,
  normalizeAgentMessages,
} from "../lib/chat-agent";

describe("OpenAI chat agent", () => {
  it("builds OpenAI Responses payload from multi-turn chat history", () => {
    const payload = buildOpenAIChatPayload(
      [
        {
          role: "user",
          content: "My name is Art.",
        },
        {
          role: "assistant",
          content: "Got it.",
        },
        {
          role: "user",
          content: "What is my name?",
        },
      ],
      "gpt-test",
      900,
    );

    expect(payload).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 900,
      truncation: "disabled",
    });
    expect(payload.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "My name is Art.",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Got it.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "What is my name?",
          },
        ],
      },
    ]);
  });

  it("calls OpenAI through the agent and returns answer text only", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Hello from agent." }), { status: 200 }));
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await agent.respond([
      {
        role: "user",
        content: "Say hello.",
      },
    ]);
    const [, init] = fetcher.mock.calls[0];

    expect(fetcher).toHaveBeenCalledWith(
      OPENAI_CHAT_RESPONSES_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-test",
      input: [
        {
          role: "user",
        },
      ],
    });
    expect(result).toMatchObject({
      answer: "Hello from agent.",
      model: "gpt-test",
      usage: {
        currentRequestTokens: expect.any(Number),
        historyTokens: expect.any(Number),
        responseTokens: expect.any(Number),
        totalTokens: expect.any(Number),
        contextWindowTokens: expect.any(Number),
        remainingContextTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number),
        failureMode: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("openai-key");
  });

  it("supports custom instructions in the payload and respond options", async () => {
    const payload = buildOpenAIChatPayload(
      [
        {
          role: "user",
          content: "Hi.",
        },
      ],
      "gpt-test",
      900,
      "Custom system prompt.",
    );

    expect(payload.instructions).toBe("Custom system prompt.");

    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Done." }), { status: 200 }));
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await agent.respond(
      [
        {
          role: "user",
          content: "Hi.",
        },
      ],
      { instructions: "Custom system prompt with summary." },
    );

    const [, init] = fetcher.mock.calls[0];

    expect(JSON.parse(String(init?.body)).instructions).toBe("Custom system prompt with summary.");
  });

  it("falls back to the default instructions when none are passed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Done." }), { status: 200 }));
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-test",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await agent.respond([
      {
        role: "user",
        content: "Hi.",
      },
    ]);

    const [, init] = fetcher.mock.calls[0];

    expect(JSON.parse(String(init?.body)).instructions).toBe(CHAT_AGENT_INSTRUCTIONS);
  });

  it("counts custom instructions in the preflight context check", async () => {
    vi.stubEnv("OPENAI_CONTEXT_WINDOW_TOKENS", "40");

    const fetcher = vi.fn();
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-test",
      fetcher: fetcher as unknown as typeof fetch,
      maxOutputTokens: 10,
    });
    const longInstructions = `Context summary: ${"facts ".repeat(50)}`;

    await expect(
      agent.respond(
        [
          {
            role: "user",
            content: "Hi.",
          },
        ],
        { instructions: longInstructions },
      ),
    ).rejects.toMatchObject({
      status: 413,
      usage: {
        failureMode: "preflight_context_overflow",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("uses provider token usage when OpenAI returns it", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: "Usage answer.",
            usage: {
              input_tokens: 42,
              input_tokens_details: {
                cached_tokens: 10,
              },
              output_tokens: 7,
              output_tokens_details: {
                reasoning_tokens: 2,
              },
              total_tokens: 49,
            },
          }),
          { status: 200 },
        ),
    );
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-5.4-mini-2026-03-17",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await agent.respond([
      {
        role: "user",
        content: "Count usage.",
      },
    ]);

    expect(result.usage).toMatchObject({
      historyTokens: 42,
      responseTokens: 7,
      totalTokens: 49,
      cachedInputTokens: 10,
      reasoningTokens: 2,
      isEstimate: false,
    });
  });

  it("blocks requests before the provider when context window is exceeded", async () => {
    vi.stubEnv("OPENAI_CONTEXT_WINDOW_TOKENS", "20");

    const fetcher = vi.fn();
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      model: "gpt-test",
      fetcher: fetcher as unknown as typeof fetch,
      maxOutputTokens: 10,
    });

    await expect(
      agent.respond([
        {
          role: "user",
          content: "This request cannot fit.",
        },
      ]),
    ).rejects.toMatchObject({
      status: 413,
      usage: {
        failureMode: "preflight_context_overflow",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("uses a safe lightweight default chat model", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: "Default model answer." }), { status: 200 }));
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      fetcher: fetcher as unknown as typeof fetch,
    });

    const result = await agent.respond([
      {
        role: "user",
        content: "Which model?",
      },
    ]);

    expect(result.model).toBe(DEFAULT_OPENAI_CHAT_MODEL);
    expect(result.model).not.toContain("pro");
  });

  it("validates message shape and latest user message", () => {
    expect(() => normalizeAgentMessages([])).toThrow("At least one message");
    expect(() =>
      normalizeAgentMessages([
        {
          role: "assistant",
          content: "Waiting.",
        },
      ]),
    ).toThrow("Latest message must be from the user");
    expect(() =>
      normalizeAgentMessages([
        {
          role: "user",
          content: "   ",
        },
      ]),
    ).toThrow("content is required");
  });

  it("surfaces provider errors without returning secrets", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Model is unavailable.",
            },
          }),
          { status: 429 },
        ),
    );
    const agent = new OpenAIChatAgent({
      apiKey: "openai-key",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(
      agent.respond([
        {
          role: "user",
          content: "Hello.",
        },
      ]),
    ).rejects.toThrow("Model is unavailable.");
  });

  it("extracts nested OpenAI output text", () => {
    expect(
      extractOpenAIText({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "First",
              },
              {
                type: "output_text",
                text: "Second",
              },
            ],
          },
        ],
      }),
    ).toBe("First\nSecond");
  });
});
