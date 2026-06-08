import { describe, expect, it, vi } from "vitest";
import {
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
    expect(result).toEqual({
      answer: "Hello from agent.",
      model: "gpt-test",
    });
    expect(JSON.stringify(result)).not.toContain("openai-key");
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
