import { describe, expect, it, vi } from "vitest";
import { buildOpenAIRequest, handleOpenAIResponseRequest } from "../lib/openai-response";

const baseInput = {
  secret: "local-secret",
  model: "gpt-5.5",
  text: "Main input",
  systemPrompt: "System rules",
  userPrompt: "User prefix",
  assistantPrompt: "Assistant context",
  temperature: "0.3",
  top_p: "0.9",
  max_output_tokens: "500",
  top_k: "40",
  seed: "7",
  frequency_penalty: "1",
  presence_penalty: "1",
};

describe("openai response proxy", () => {
  it("returns 401 and does not call OpenAI when secret is wrong", async () => {
    const fetcher = vi.fn();

    const result = await handleOpenAIResponseRequest(
      { ...baseInput, secret: "wrong" },
      { SECRET: "local-secret", OPENAI_API_KEY: "key" },
      fetcher,
    );

    expect(result.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not include secret in returned OpenAI request", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "resp_123" }), { status: 200 }));

    const result = await handleOpenAIResponseRequest(
      baseInput,
      { SECRET: "local-secret", OPENAI_API_KEY: "key" },
      fetcher,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      request: {
        model: "gpt-5.5",
      },
      response: {
        id: "resp_123",
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("local-secret");
  });

  it("omits unsupported params from OpenAI payload", () => {
    const request = buildOpenAIRequest(baseInput);

    expect(request).not.toHaveProperty("top_k");
    expect(request).not.toHaveProperty("seed");
    expect(request).not.toHaveProperty("frequency_penalty");
    expect(request).not.toHaveProperty("presence_penalty");
  });

  it("composes instructions and input messages", () => {
    const request = buildOpenAIRequest(baseInput);

    expect(request.instructions).toBe("System rules");
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
});
