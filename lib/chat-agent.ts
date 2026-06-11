import {
  applyProviderUsage,
  buildTokenUsageEstimate,
  markTokenFailure,
  normalizeMessageTokenUsage,
  readOpenAIProviderUsage,
  type AgentMessageTokenUsage,
  type AgentTokenUsage,
} from "./token-usage";

export const OPENAI_CHAT_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_CHAT_MODEL = "gpt-5.4-mini-2026-03-17";
export const CHAT_AGENT_INSTRUCTIONS =
  "You are a concise, helpful chat agent. Keep context from prior messages and answer the user's latest request.";

export type AgentChatRole = "user" | "assistant";

export type AgentChatMessage = {
  role: AgentChatRole;
  content: string;
  usage?: AgentMessageTokenUsage;
};

export type OpenAIChatAgentResult = {
  answer: string;
  model: string;
  usage: AgentTokenUsage;
};

export type OpenAIChatAgentOptions = {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  maxOutputTokens?: number;
};

export type OpenAIChatRespondOptions = {
  instructions?: string;
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
  truncation: "disabled";
};

export class ChatAgentError extends Error {
  readonly status: number;
  readonly usage?: AgentTokenUsage;

  constructor(message: string, status = 400, usage?: AgentTokenUsage) {
    super(message);
    this.name = "ChatAgentError";
    this.status = status;
    this.usage = usage;
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

  async respond(messages: AgentChatMessage[], options?: OpenAIChatRespondOptions): Promise<OpenAIChatAgentResult> {
    const instructions = options?.instructions?.trim() || CHAT_AGENT_INSTRUCTIONS;
    const normalizedMessages = normalizeAgentMessages(messages);
    const estimate = buildTokenUsageEstimate({
      messages: normalizedMessages,
      instructions,
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
    });

    if (estimate.historyTokens + this.maxOutputTokens > estimate.contextWindowTokens) {
      const usage = markTokenFailure(estimate, "preflight_context_overflow");

      throw new ChatAgentError(
        `Context window exceeded: ${estimate.historyTokens} prompt tokens + ${this.maxOutputTokens} reserved output tokens is larger than ${estimate.contextWindowTokens}.`,
        413,
        usage,
      );
    }

    const payload = buildOpenAIChatPayload(normalizedMessages, this.model, this.maxOutputTokens, instructions);

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
      const failureMode = response.status === 400 ? "provider_context_overflow" : "provider_error";

      throw new ChatAgentError(
        readOpenAIErrorMessage(parsedOutput) || `OpenAI request failed with ${response.status}.`,
        response.status,
        markTokenFailure(estimate, failureMode),
      );
    }

    const answer = extractOpenAIText(parsedOutput);

    if (!answer) {
      throw new ChatAgentError("OpenAI response did not include text output.", 502);
    }

    const providerUsage = readOpenAIProviderUsage(parsedOutput);
    const usage = providerUsage
      ? applyProviderUsage(estimate, providerUsage, this.model)
      : buildTokenUsageEstimate({
          messages: normalizedMessages,
          instructions,
          model: this.model,
          maxOutputTokens: this.maxOutputTokens,
          responseText: answer,
        });

    return {
      answer,
      model: this.model,
      usage,
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
      usage: normalizeMessageTokenUsage(message.usage),
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
  instructions = CHAT_AGENT_INSTRUCTIONS,
): OpenAIChatPayload {
  return {
    model,
    instructions,
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
    truncation: "disabled",
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
