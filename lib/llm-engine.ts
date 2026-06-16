import { AppStoreError, isRecord } from "./db";
import type { LlmProvider } from "./admin-settings";

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateTextInput = {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
};

export type LlmResult = {
  provider: LlmProvider;
  model: string;
  outputText: string;
  raw: unknown;
  usage: Record<string, unknown>;
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export async function generateText(input: GenerateTextInput): Promise<LlmResult> {
  if (input.provider === "anthropic") {
    return generateAnthropicText(input);
  }

  return generateOpenAIText(input);
}

async function generateOpenAIText(input: GenerateTextInput): Promise<LlmResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new AppStoreError("OPENAI_API_KEY is not configured.");
  }

  const request = {
    model: input.model,
    instructions: input.system,
    input: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
    ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
  };

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const raw = await readJsonOrText(response);

  if (!response.ok) {
    throw new AppStoreError(extractErrorMessage(raw) || `OpenAI request failed with ${response.status}.`, response.status);
  }

  return {
    provider: "openai",
    model: input.model,
    outputText: extractOpenAIText(raw),
    raw,
    usage: isRecord(raw) && isRecord(raw.usage) ? raw.usage : {},
  };
}

async function generateAnthropicText(input: GenerateTextInput): Promise<LlmResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new AppStoreError("ANTHROPIC_API_KEY is not configured.");
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens ?? 4096,
      system: input.system,
      messages: input.messages,
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
    }),
  });
  const raw = await readJsonOrText(response);

  if (!response.ok) {
    throw new AppStoreError(extractErrorMessage(raw) || `Anthropic request failed with ${response.status}.`, response.status);
  }

  return {
    provider: "anthropic",
    model: input.model,
    outputText: extractAnthropicText(raw),
    raw,
    usage: isRecord(raw) && isRecord(raw.usage) ? raw.usage : {},
  };
}

async function readJsonOrText(response: Response) {
  const text = await response.text();

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractOpenAIText(raw: unknown) {
  if (!isRecord(raw)) {
    return "";
  }

  if (typeof raw.output_text === "string") {
    return raw.output_text.trim();
  }

  const parts: string[] = [];

  if (Array.isArray(raw.output)) {
    for (const item of raw.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        continue;
      }

      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === "string" && content.text.trim()) {
          parts.push(content.text.trim());
        }
      }
    }
  }

  return parts.join("\n");
}

function extractAnthropicText(raw: unknown) {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    return "";
  }

  return raw.content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractErrorMessage(raw: unknown) {
  if (isRecord(raw) && isRecord(raw.error) && typeof raw.error.message === "string") {
    return raw.error.message;
  }

  if (isRecord(raw) && typeof raw.message === "string") {
    return raw.message;
  }

  return "";
}
