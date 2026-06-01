import { timingSafeEqual } from "node:crypto";
import { isKnownModel, type ModelOption } from "./models";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export type ClientOpenAIRequest = {
  secret?: unknown;
  model?: unknown;
  text?: unknown;
  systemPrompt?: unknown;
  userPrompt?: unknown;
  assistantPrompt?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_output_tokens?: unknown;
  top_k?: unknown;
  seed?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
};

export type OpenAIMessage = {
  role: "user" | "assistant";
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

export type OpenAIResponsesPayload = {
  model: ModelOption;
  input: OpenAIMessage[];
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
};

export type HandlerEnv = {
  SECRET?: string;
  OPENAI_API_KEY?: string;
};

export type HandlerResult = {
  status: number;
  body: unknown;
};

type Fetcher = typeof fetch;

const unsupportedFields = [
  "top_k",
  "seed",
  "frequency_penalty",
  "presence_penalty",
] as const;

export function validateSecret(providedSecret: unknown, expectedSecret?: string) {
  if (typeof providedSecret !== "string" || !expectedSecret) {
    return false;
  }

  const provided = Buffer.from(providedSecret);
  const expected = Buffer.from(expectedSecret);

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function buildOpenAIRequest(input: ClientOpenAIRequest): OpenAIResponsesPayload {
  const model = readModel(input.model);
  const text = readRequiredString(input.text, "text");
  const systemPrompt = readOptionalString(input.systemPrompt);
  const userPrompt = readOptionalString(input.userPrompt);
  const assistantPrompt = readOptionalString(input.assistantPrompt);
  const userText = [userPrompt, text].filter(Boolean).join("\n\n");
  const messages: OpenAIMessage[] = [];

  if (assistantPrompt) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: assistantPrompt,
        },
      ],
    });
  }

  messages.push({
    role: "user",
    content: [
      {
        type: "input_text",
        text: userText,
      },
    ],
  });

  const request: OpenAIResponsesPayload = {
    model,
    input: messages,
  };

  if (systemPrompt) {
    request.instructions = systemPrompt;
  }

  const temperature = readNumber(input.temperature, "temperature", 0, 2);
  const topP = readNumber(input.top_p, "top_p", 0, 1);
  const maxOutputTokens = readInteger(input.max_output_tokens, "max_output_tokens", 1, 200000);

  if (temperature !== undefined) {
    request.temperature = temperature;
  }

  if (topP !== undefined) {
    request.top_p = topP;
  }

  if (maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  return request;
}

export async function handleOpenAIResponseRequest(
  input: ClientOpenAIRequest,
  env: HandlerEnv,
  fetcher: Fetcher = fetch,
): Promise<HandlerResult> {
  if (!env.SECRET) {
    return {
      status: 500,
      body: {
        error: {
          message: "SECRET is not configured.",
        },
      },
    };
  }

  if (!validateSecret(input.secret, env.SECRET)) {
    return {
      status: 401,
      body: {
        error: {
          message: "Invalid secret.",
        },
      },
    };
  }

  if (!env.OPENAI_API_KEY) {
    return {
      status: 500,
      body: {
        error: {
          message: "OPENAI_API_KEY is not configured.",
        },
      },
    };
  }

  try {
    const request = buildOpenAIRequest(stripUnsupported(input));
    const response = await fetcher(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    const rawOutput = await response.text();
    const parsedOutput = parseJson(rawOutput);

    return {
      status: response.status,
      body: {
        request,
        response: parsedOutput,
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: {
        error: {
          message: error instanceof Error ? error.message : "Invalid request.",
        },
      },
    };
  }
}

function stripUnsupported(input: ClientOpenAIRequest): ClientOpenAIRequest {
  const supported = { ...input };

  for (const field of unsupportedFields) {
    delete supported[field];
  }

  return supported;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function readModel(value: unknown): ModelOption {
  if (typeof value !== "string" || !isKnownModel(value)) {
    throw new Error("Select a supported model.");
  }

  return value;
}

function readRequiredString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown, fieldName: string, min: number, max: number) {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}.`);
  }

  return number;
}

function readInteger(value: unknown, fieldName: string, min: number, max: number) {
  const number = readNumber(value, fieldName, min, max);

  if (number === undefined) {
    return undefined;
  }

  if (!Number.isInteger(number)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  return number;
}
