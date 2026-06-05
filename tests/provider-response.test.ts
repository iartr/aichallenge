import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  OPENAI_RESPONSES_URL,
  buildAnthropicRequest,
  buildOpenAIRequest,
  extractProviderOutputText,
  handleProviderResponseRequest,
} from "../lib/provider-response";

const openAIInput = {
  secret: "local-secret",
  provider: "openai",
  model: "gpt-5.4-2026-03-05",
  text: "Main input",
  systemPrompt: "System rules",
  userPrompt: "User prefix",
  assistantPrompt: "Assistant context",
  temperature: "0.3",
  max_output_tokens: "500",
  reasoning_effort: "high",
  reasoning_summary: "auto",
  text_verbosity: "low",
};

const anthropicInput = {
  secret: "local-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  text: "Main input",
  systemPrompt: "System rules",
  userPrompt: "User prefix",
  assistantPrompt: "Assistant context",
  top_p: "0.97",
  max_output_tokens: "5000",
  thinking_mode: "adaptive",
  thinking_display: "summarized",
  anthropic_effort: "medium",
};

describe("provider response proxy", () => {
  it("returns 401 and does not call providers when secret is wrong", async () => {
    const fetcher = vi.fn();

    const result = await handleProviderResponseRequest(
      { ...openAIInput, secret: "wrong" },
      { SECRET: "local-secret", OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key" },
      fetcher,
    );

    expect(result.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("builds OpenAI payload with reasoning and verbosity", () => {
    const request = buildOpenAIRequest(openAIInput);

    expect(request).toMatchObject({
      model: "gpt-5.4-2026-03-05",
      instructions: "System rules",
      temperature: 0.3,
      max_output_tokens: 500,
      reasoning: {
        effort: "high",
        summary: "auto",
      },
      text: {
        verbosity: "low",
      },
    });
    expect(request.input).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Assistant context",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "User prefix\n\nMain input",
          },
        ],
      },
    ]);
  });

  it("omits OpenAI reasoning when effort is off", () => {
    const request = buildOpenAIRequest({
      ...openAIInput,
      reasoning_effort: "off",
      reasoning_summary: "off",
    });

    expect(request).not.toHaveProperty("reasoning");
  });

  it("allows OpenAI pro reasoning to be omitted or explicitly high", () => {
    const omittedRequest = buildOpenAIRequest({
      ...openAIInput,
      model: "gpt-5.5-pro-2026-04-23",
      temperature: "",
      reasoning_effort: "off",
      reasoning_summary: "off",
    });
    const request = buildOpenAIRequest({
      ...openAIInput,
      model: "gpt-5.5-pro-2026-04-23",
      temperature: "",
      reasoning_effort: "high",
    });

    expect(omittedRequest).not.toHaveProperty("reasoning");
    expect(request.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    });
  });

  it("rejects unsupported GPT-5.5 sampling before provider fetch", () => {
    expect(() =>
      buildOpenAIRequest({
        ...openAIInput,
        model: "gpt-5.5",
        reasoning_effort: "off",
      }),
    ).toThrow("gpt-5.5 does not support temperature");
    expect(() =>
      buildOpenAIRequest({
        ...openAIInput,
        model: "gpt-5.5-2026-04-23",
        temperature: "",
        top_p: "0.9",
        reasoning_effort: "off",
      }),
    ).toThrow("gpt-5.5-2026-04-23 does not support top_p");
  });

  it("builds GPT-5.5 payload without sampling when controls are empty", () => {
    const request = buildOpenAIRequest({
      ...openAIInput,
      model: "gpt-5.5",
      temperature: "",
      reasoning_effort: "off",
      reasoning_summary: "off",
    });

    expect(request).toMatchObject({
      model: "gpt-5.5",
      max_output_tokens: 500,
    });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("reasoning");
  });

  it("allows GPT-5.4 mini and nano sampling controls", () => {
    const miniRequest = buildOpenAIRequest({
      ...openAIInput,
      model: "gpt-5.4-mini-2026-03-17",
      temperature: "0.4",
      top_p: "",
      reasoning_effort: "off",
      reasoning_summary: "off",
    });
    const nanoRequest = buildOpenAIRequest({
      ...openAIInput,
      model: "gpt-5.4-nano-2026-03-17",
      temperature: "",
      top_p: "0.9",
      reasoning_effort: "off",
      reasoning_summary: "off",
    });

    expect(miniRequest).toMatchObject({
      model: "gpt-5.4-mini-2026-03-17",
      temperature: 0.4,
    });
    expect(nanoRequest).toMatchObject({
      model: "gpt-5.4-nano-2026-03-17",
      top_p: 0.9,
    });
  });

  it("builds Anthropic payload with thinking, effort, and messages", () => {
    const request = buildAnthropicRequest(anthropicInput);

    expect(request).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 5000,
      system: "System rules",
      top_p: 0.97,
      thinking: {
        type: "adaptive",
        display: "summarized",
      },
      output_config: {
        effort: "medium",
      },
      messages: [
        {
          role: "assistant",
          content: "Assistant context",
        },
        {
          role: "user",
          content: "User prefix\n\nMain input",
        },
      ],
    });
  });

  it("rejects unsupported Anthropic sampling before provider fetch", () => {
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-opus-4-8",
        temperature: "0.2",
        top_p: "",
        thinking_mode: "disabled",
      }),
    ).toThrow("claude-opus-4-8 does not support temperature");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-opus-4-8",
        thinking_mode: "disabled",
      }),
    ).toThrow("claude-opus-4-8 does not support top_p");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        top_p: "",
        top_k: "5",
        thinking_mode: "disabled",
      }),
    ).toThrow("claude-sonnet-4-6 does not support top_k");
  });

  it("allows Haiku sampling controls", () => {
    const request = buildAnthropicRequest({
      ...anthropicInput,
      model: "claude-haiku-4-5-20251001",
      temperature: "0.4",
      top_p: "",
      top_k: "5",
      thinking_mode: "disabled",
      thinking_display: "",
      anthropic_effort: "",
    });

    expect(request).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      temperature: 0.4,
      top_k: 5,
    });
  });

  it("sends Anthropic requests with server API key headers and hides secrets", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }));

    const result = await handleProviderResponseRequest(
      anthropicInput,
      { SECRET: "local-secret", OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key" },
      fetcher,
    );
    const [, init] = fetcher.mock.calls[0];

    expect(fetcher).toHaveBeenCalledWith(
      ANTHROPIC_MESSAGES_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "anthropic-key",
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-sonnet-4-6",
      thinking: {
        type: "adaptive",
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      provider: "anthropic",
      request: {
        model: "claude-sonnet-4-6",
      },
      response: {
        id: "msg_123",
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("local-secret");
    expect(JSON.stringify(result.body)).not.toContain("anthropic-key");
  });

  it("sends OpenAI requests with the OpenAI endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "resp_123" }), { status: 200 }));

    const result = await handleProviderResponseRequest(
      openAIInput,
      { SECRET: "local-secret", OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key" },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      OPENAI_RESPONSES_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
        }),
      }),
    );
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain("openai-key");
  });

  it("extracts OpenAI top-level output text before nested output text", () => {
    const outputText = extractProviderOutputText("openai", {
      output_text: "Top-level answer",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "Nested answer",
            },
          ],
        },
      ],
    });

    expect(outputText).toBe("Top-level answer");
  });

  it("extracts OpenAI nested output text and ignores reasoning blocks", () => {
    const outputText = extractProviderOutputText("openai", {
      output: [
        {
          type: "reasoning",
          content: [
            {
              type: "summary_text",
              text: "Hidden reasoning",
            },
          ],
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "First answer",
            },
            {
              type: "refusal",
              refusal: "Ignored refusal metadata",
            },
            {
              type: "output_text",
              text: "Second answer",
            },
          ],
        },
      ],
    });

    expect(outputText).toBe("First answer\nSecond answer");
  });

  it("extracts Anthropic text blocks and ignores thinking blocks", () => {
    const outputText = extractProviderOutputText("anthropic", {
      content: [
        {
          type: "thinking",
          thinking: "Hidden thinking",
        },
        {
          type: "text",
          text: "First answer",
        },
        {
          type: "text",
          text: "Second answer",
        },
      ],
    });

    expect(outputText).toBe("First answer\nSecond answer");
  });

  it("returns an empty output text fallback when provider text is absent", () => {
    expect(
      extractProviderOutputText("openai", {
        output: [
          {
            type: "reasoning",
            content: [
              {
                type: "summary_text",
                text: "Reasoning only",
              },
            ],
          },
        ],
      }),
    ).toBe("");
    expect(
      extractProviderOutputText("anthropic", {
        content: [
          {
            type: "thinking",
            thinking: "Thinking only",
          },
        ],
      }),
    ).toBe("");
  });

  it("returns provider-specific API key configuration errors before fetch", async () => {
    const fetcher = vi.fn();

    const result = await handleProviderResponseRequest(
      anthropicInput,
      { SECRET: "local-secret", OPENAI_API_KEY: "openai-key" },
      fetcher,
    );

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({
      error: {
        message: "ANTHROPIC_API_KEY is not configured.",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported provider and model combinations", () => {
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "gpt-5.5",
      }),
    ).toThrow("Select a supported Anthropic model.");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-opus-4-8",
        thinking_mode: "manual",
      }),
    ).toThrow("does not support manual thinking");
  });

  it("rejects conflicting sampling parameters", () => {
    expect(() =>
      buildOpenAIRequest({
        ...openAIInput,
        top_p: "0.9",
      }),
    ).toThrow("Use either temperature or top_p");
  });

  it("rejects Anthropic thinking-incompatible sampling controls", () => {
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        top_p: "",
        temperature: "0.2",
      }),
    ).toThrow("temperature is not compatible");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-haiku-4-5-20251001",
        thinking_mode: "manual",
        thinking_budget_tokens: "1024",
        anthropic_effort: "",
        top_k: "5",
      }),
    ).toThrow("top_k is not compatible");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        top_p: "0.9",
      }),
    ).toThrow("top_p must be between 0.95 and 1");
  });

  it("validates Anthropic manual thinking budgets", () => {
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-haiku-4-5-20251001",
        anthropic_effort: "",
        thinking_mode: "manual",
        thinking_budget_tokens: "1000",
      }),
    ).toThrow("thinking_budget_tokens must be between 1024");
    expect(() =>
      buildAnthropicRequest({
        ...anthropicInput,
        model: "claude-haiku-4-5-20251001",
        anthropic_effort: "",
        thinking_mode: "manual",
        thinking_budget_tokens: "5000",
        max_output_tokens: "5000",
      }),
    ).toThrow("thinking_budget_tokens must be less than max_tokens");
  });
});
