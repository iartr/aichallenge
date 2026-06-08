export const OPENAI_CHAT_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.4-mini-2026-03-17";

export type AgentChatRole = "user" | "assistant";

export type AgentChatMessage = {
  role: AgentChatRole;
  content: string;
};

export type OpenAIChatAgentResult = {
  answer: string;
  model: string;
};

export type OpenAIChatAgentOptions = {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  maxOutputTokens?: number;
};

type OpenAIChatInputMessage = {
  role: AgentChatRole;
  content: Array<
    | {
        type: "input_text";
        text: string;
      }
    | {
        type: "output_text";
        text: string;
      }
  >;
};

type OpenAIChatPayload = {
  model: string;
  instructions: string;
  input: OpenAIChatInputMessage[];
  max_output_tokens: number;
};

export class ChatAgentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatAgentError";
    this.status = status;
  }
}

export class OpenAIChatAgent {
  readonly model: string;

  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly maxOutputTokens: number;

  constructor({ apiKey, model, fetcher = fetch, maxOutputTokens = 1200 }: OpenAIChatAgentOptions) {
    if (!apiKey) {
      throw new ChatAgentError("OPENAI_API_KEY is not configured.", 500);
    }

    this.apiKey = apiKey;
    this.model = model || DEFAULT_OPENAI_CHAT_MODEL;
    this.fetcher = fetcher;
    this.maxOutputTokens = maxOutputTokens;
  }

  async respond(messages: AgentChatMessage[]): Promise<OpenAIChatAgentResult> {
    const normalizedMessages = normalizeAgentMessages(messages);
    const payload = buildOpenAIChatPayload(normalizedMessages, this.model, this.maxOutputTokens);

    const response = await this.fetcher(OPENAI_CHAT_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const rawOutput = await response.text();
    const parsedOutput = parseJson(rawOutput);

    if (!response.ok) {
      throw new ChatAgentError(readOpenAIErrorMessage(parsedOutput) || `OpenAI request failed with ${response.status}.`, response.status);
    }

    const answer = extractOpenAIText(parsedOutput);

    if (!answer) {
      throw new ChatAgentError("OpenAI response did not include text output.", 502);
    }

    return {
      answer,
      model: this.model,
    };
  }
}

export function normalizeAgentMessages(messages: unknown): AgentChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new ChatAgentError("messages must be an array.");
  }

  const normalized: AgentChatMessage[] = messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new ChatAgentError(`messages[${index}] must be an object.`);
    }

    const role = message.role;

    if (role !== "user" && role !== "assistant") {
      throw new ChatAgentError(`messages[${index}].role must be user or assistant.`);
    }

    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new ChatAgentError(`messages[${index}].content is required.`);
    }

    return {
      role,
      content: message.content.trim(),
    };
  });

  if (normalized.length === 0) {
    throw new ChatAgentError("At least one message is required.");
  }

  if (normalized[normalized.length - 1]?.role !== "user") {
    throw new ChatAgentError("Latest message must be from the user.");
  }

  return normalized;
}

export function buildOpenAIChatPayload(
  messages: AgentChatMessage[],
  model = DEFAULT_OPENAI_CHAT_MODEL,
  maxOutputTokens = 1200,
): OpenAIChatPayload {
  return {
    model,
    instructions: "You are a concise, helpful chat agent. Keep context from prior messages and answer the user's latest request.",
    input: messages.map((message) => ({
      role: message.role,
      content: [
        message.role === "user"
          ? {
              type: "input_text",
              text: message.content,
            }
          : {
              type: "output_text",
              text: message.content,
            },
      ],
    })),
    max_output_tokens: maxOutputTokens,
  };
}

export function extractOpenAIText(output: unknown) {
  if (!isRecord(output)) {
    return "";
  }

  if (typeof output.output_text === "string" && output.output_text.trim()) {
    return output.output_text.trim();
  }

  const parts: string[] = [];

  if (Array.isArray(output.output)) {
    for (const item of output.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        continue;
      }

      for (const content of item.content) {
        if (
          isRecord(content) &&
          content.type === "output_text" &&
          typeof content.text === "string" &&
          content.text.trim()
        ) {
          parts.push(content.text.trim());
        }
      }
    }
  }

  return parts.join("\n");
}

function readOpenAIErrorMessage(value: unknown) {
  if (!isRecord(value)) {
    return "";
  }

  if (isRecord(value.error) && typeof value.error.message === "string" && value.error.message.trim()) {
    return value.error.message.trim();
  }

  if (typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }

  return "";
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
