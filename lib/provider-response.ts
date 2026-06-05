import { timingSafeEqual } from "node:crypto";
import {
  ANTHROPIC_EFFORTS,
  ANTHROPIC_THINKING_DISPLAYS,
  ANTHROPIC_THINKING_MODES,
  OPENAI_REASONING_SUMMARIES,
  TEXT_VERBOSITIES,
  getModelOption,
  isKnownProvider,
  type AnthropicEffort,
  type AnthropicModelOption,
  type AnthropicThinkingDisplay,
  type AnthropicThinkingMode,
  type ModelId,
  type OpenAISamplingControl,
  type OpenAIModelOption,
  type OpenAIReasoningEffort,
  type OpenAIReasoningSummary,
  type ProviderOption,
  type TextVerbosity,
} from "./models";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export type ClientProviderRequest = {
  secret?: unknown;
  provider?: unknown;
  model?: unknown;
  text?: unknown;
  systemPrompt?: unknown;
  userPrompt?: unknown;
  assistantPrompt?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  max_output_tokens?: unknown;
  max_tokens?: unknown;
  reasoning_effort?: unknown;
  reasoning_summary?: unknown;
  text_verbosity?: unknown;
  thinking_mode?: unknown;
  thinking_budget_tokens?: unknown;
  thinking_display?: unknown;
  anthropic_effort?: unknown;
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
  model: ModelId;
  input: OpenAIMessage[];
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: {
    effort?: Exclude<OpenAIReasoningEffort, "off">;
    summary?: Exclude<OpenAIReasoningSummary, "off">;
  };
  text?: {
    verbosity: TextVerbosity;
  };
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AnthropicMessagesPayload = {
  model: ModelId;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?:
    | {
        type: "adaptive";
        display?: AnthropicThinkingDisplay;
      }
    | {
        type: "enabled";
        budget_tokens: number;
        display?: AnthropicThinkingDisplay;
      };
  output_config?: {
    effort: AnthropicEffort;
  };
};

export type ProviderPayload =
  | {
      provider: "openai";
      url: typeof OPENAI_RESPONSES_URL;
      request: OpenAIResponsesPayload;
    }
  | {
      provider: "anthropic";
      url: typeof ANTHROPIC_MESSAGES_URL;
      request: AnthropicMessagesPayload;
    };

export type HandlerEnv = {
  SECRET?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

export type HandlerResult = {
  status: number;
  body: unknown;
};

type Fetcher = typeof fetch;

export function validateSecret(providedSecret: unknown, expectedSecret?: string) {
  if (typeof providedSecret !== "string" || !expectedSecret) {
    return false;
  }

  const provided = Buffer.from(providedSecret);
  const expected = Buffer.from(expectedSecret);

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function buildProviderRequest(input: ClientProviderRequest): ProviderPayload {
  const provider = readProvider(input.provider);

  if (provider === "openai") {
    return {
      provider,
      url: OPENAI_RESPONSES_URL,
      request: buildOpenAIRequest(input),
    };
  }

  return {
    provider,
    url: ANTHROPIC_MESSAGES_URL,
    request: buildAnthropicRequest(input),
  };
}

export function buildOpenAIRequest(input: ClientProviderRequest): OpenAIResponsesPayload {
  const model = readOpenAIModel(input.model);
  const { text, systemPrompt, userText, assistantPrompt } = readPrompts(input);
  const { temperature, topP } = readOpenAISampling(input, model);
  const maxOutputTokens = readInteger(firstPresent(input.max_output_tokens, input.max_tokens), "max_output_tokens", 1, 200000);
  const reasoningEffort = readOpenAIReasoningEffort(input.reasoning_effort, model);
  const reasoningSummary = readOpenAIReasoningSummary(input.reasoning_summary);
  const textVerbosity = readEnum(input.text_verbosity, "text_verbosity", TEXT_VERBOSITIES);

  rejectProvided(input.top_k, "top_k is not supported by OpenAI Responses requests.");
  rejectProvided(input.seed, "seed is not supported by this OpenAI Responses proxy.");
  rejectProvided(input.frequency_penalty, "frequency_penalty is not supported by this OpenAI Responses proxy.");
  rejectProvided(input.presence_penalty, "presence_penalty is not supported by this OpenAI Responses proxy.");

  if ((reasoningEffort === "off" || reasoningEffort === "none") && reasoningSummary !== "off") {
    throw new Error("reasoning_summary requires enabled reasoning effort.");
  }

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
        text: userText || text,
      },
    ],
  });

  const request: OpenAIResponsesPayload = {
    model: model.id as ModelId,
    input: messages,
  };

  if (systemPrompt) {
    request.instructions = systemPrompt;
  }

  if (temperature !== undefined) {
    request.temperature = temperature;
  }

  if (topP !== undefined) {
    request.top_p = topP;
  }

  if (maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  if (reasoningSummary !== "off") {
    request.reasoning = {
      ...request.reasoning,
      summary: reasoningSummary,
    };
  }

  if (reasoningEffort !== "off") {
    request.reasoning = {
      ...request.reasoning,
      effort: reasoningEffort,
    };
  }

  if (textVerbosity !== undefined) {
    request.text = {
      verbosity: textVerbosity,
    };
  }

  return request;
}

export function buildAnthropicRequest(input: ClientProviderRequest): AnthropicMessagesPayload {
  const model = readAnthropicModel(input.model);
  const { text, systemPrompt, userText, assistantPrompt } = readPrompts(input);
  const thinkingMode = readAnthropicThinkingMode(input.thinking_mode, model);
  const thinkingEnabled = thinkingMode !== "disabled";
  const { temperature, topP } = readSampling(input, {
    temperatureMax: 1,
    topPMin: thinkingEnabled ? 0.95 : 0,
  });
  const topK = readInteger(input.top_k, "top_k", 0, Number.MAX_SAFE_INTEGER);
  const maxTokens = readInteger(firstPresent(input.max_tokens, input.max_output_tokens), "max_tokens", 1, model.maxTokens);
  const thinkingDisplay = readThinkingDisplay(input.thinking_display, thinkingEnabled);
  const anthropicEffort = readAnthropicEffort(input.anthropic_effort, model);

  if (maxTokens === undefined) {
    throw new Error("max_tokens is required.");
  }

  if (thinkingEnabled && temperature !== undefined) {
    throw new Error("temperature is not compatible with Anthropic thinking.");
  }

  if (thinkingEnabled && topK !== undefined) {
    throw new Error("top_k is not compatible with Anthropic thinking.");
  }

  const messages: AnthropicMessage[] = [];

  if (assistantPrompt) {
    messages.push({
      role: "assistant",
      content: assistantPrompt,
    });
  }

  messages.push({
    role: "user",
    content: userText || text,
  });

  const request: AnthropicMessagesPayload = {
    model: model.id as ModelId,
    max_tokens: maxTokens,
    messages,
  };

  if (systemPrompt) {
    request.system = systemPrompt;
  }

  if (temperature !== undefined) {
    request.temperature = temperature;
  }

  if (topP !== undefined) {
    request.top_p = topP;
  }

  if (topK !== undefined) {
    request.top_k = topK;
  }

  if (thinkingMode === "adaptive") {
    request.thinking = {
      type: "adaptive",
      ...(thinkingDisplay ? { display: thinkingDisplay } : {}),
    };
  }

  if (thinkingMode === "manual") {
    const budgetTokens = readInteger(input.thinking_budget_tokens, "thinking_budget_tokens", 1024, Number.MAX_SAFE_INTEGER);

    if (budgetTokens === undefined) {
      throw new Error("thinking_budget_tokens is required for manual thinking.");
    }

    if (budgetTokens >= maxTokens) {
      throw new Error("thinking_budget_tokens must be less than max_tokens.");
    }

    request.thinking = {
      type: "enabled",
      budget_tokens: budgetTokens,
      ...(thinkingDisplay ? { display: thinkingDisplay } : {}),
    };
  }

  if (anthropicEffort !== undefined) {
    request.output_config = {
      effort: anthropicEffort,
    };
  }

  return request;
}

export async function handleProviderResponseRequest(
  input: ClientProviderRequest,
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

  let payload: ProviderPayload;

  try {
    payload = buildProviderRequest(input);
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

  if (payload.provider === "openai" && !env.OPENAI_API_KEY) {
    return {
      status: 500,
      body: {
        error: {
          message: "OPENAI_API_KEY is not configured.",
        },
      },
    };
  }

  if (payload.provider === "anthropic" && !env.ANTHROPIC_API_KEY) {
    return {
      status: 500,
      body: {
        error: {
          message: "ANTHROPIC_API_KEY is not configured.",
        },
      },
    };
  }

  try {
    const response = await fetcher(payload.url, {
      method: "POST",
      headers:
        payload.provider === "openai"
          ? {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            }
          : {
              "x-api-key": env.ANTHROPIC_API_KEY ?? "",
              "anthropic-version": ANTHROPIC_VERSION,
              "Content-Type": "application/json",
            },
      body: JSON.stringify(payload.request),
    });
    const rawOutput = await response.text();
    const parsedOutput = parseJson(rawOutput);

    return {
      status: response.status,
      body: {
        provider: payload.provider,
        request: payload.request,
        response: parsedOutput,
        outputText: extractProviderOutputText(payload.provider, parsedOutput),
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

export function extractProviderOutputText(provider: ProviderPayload["provider"], output: unknown) {
  if (provider === "openai") {
    return extractOpenAIOutputText(output);
  }

  return extractAnthropicOutputText(output);
}

function readProvider(value: unknown): ProviderOption {
  if (value === undefined || value === null || value === "") {
    return "openai";
  }

  if (typeof value !== "string" || !isKnownProvider(value)) {
    throw new Error("Select a supported provider.");
  }

  return value;
}

function readOpenAIModel(value: unknown): OpenAIModelOption {
  if (typeof value !== "string") {
    throw new Error("Select a supported OpenAI model.");
  }

  const model = getModelOption(value);

  if (!model || model.provider !== "openai") {
    throw new Error("Select a supported OpenAI model.");
  }

  return model;
}

function readAnthropicModel(value: unknown): AnthropicModelOption {
  if (typeof value !== "string") {
    throw new Error("Select a supported Anthropic model.");
  }

  const model = getModelOption(value);

  if (!model || model.provider !== "anthropic") {
    throw new Error("Select a supported Anthropic model.");
  }

  return model;
}

function readPrompts(input: ClientProviderRequest) {
  const text = readRequiredString(input.text, "text");
  const systemPrompt = readOptionalString(input.systemPrompt);
  const userPrompt = readOptionalString(input.userPrompt);
  const assistantPrompt = readOptionalString(input.assistantPrompt);
  const userText = [userPrompt, text].filter(Boolean).join("\n\n");

  return {
    text,
    systemPrompt,
    userText,
    assistantPrompt,
  };
}

function readOpenAIReasoningEffort(value: unknown, model: OpenAIModelOption): OpenAIReasoningEffort {
  const requested = readOptionalString(value) || model.defaultReasoningEffort;

  if (!model.reasoningEfforts.includes(requested as OpenAIReasoningEffort)) {
    throw new Error(`reasoning_effort is not supported by ${model.id}.`);
  }

  return requested as OpenAIReasoningEffort;
}

function readOpenAIReasoningSummary(value: unknown): OpenAIReasoningSummary {
  return readEnum(value, "reasoning_summary", OPENAI_REASONING_SUMMARIES) ?? "off";
}

function readOpenAISampling(input: ClientProviderRequest, model: OpenAIModelOption) {
  rejectUnsupportedOpenAISampling(input.temperature, "temperature", model);
  rejectUnsupportedOpenAISampling(input.top_p, "top_p", model);

  return readSampling(input, { temperatureMax: 2, topPMin: 0 });
}

function rejectUnsupportedOpenAISampling(value: unknown, fieldName: OpenAISamplingControl, model: OpenAIModelOption) {
  if (value !== "" && value !== null && value !== undefined && !model.samplingControls.includes(fieldName)) {
    throw new Error(`${model.id} does not support ${fieldName}.`);
  }
}

function readAnthropicThinkingMode(value: unknown, model: AnthropicModelOption): AnthropicThinkingMode {
  const requested = readEnum(value, "thinking_mode", ANTHROPIC_THINKING_MODES) ?? model.defaultThinkingMode;

  if (!model.thinkingModes.includes(requested)) {
    throw new Error(`${model.id} does not support ${requested} thinking.`);
  }

  return requested;
}

function readThinkingDisplay(value: unknown, thinkingEnabled: boolean) {
  const requested = readEnum(value, "thinking_display", ANTHROPIC_THINKING_DISPLAYS);

  if (requested && !thinkingEnabled) {
    throw new Error("thinking_display requires thinking to be enabled.");
  }

  return requested;
}

function readAnthropicEffort(value: unknown, model: AnthropicModelOption): AnthropicEffort | undefined {
  const requested = readEnum(value, "anthropic_effort", ANTHROPIC_EFFORTS);

  if (!requested) {
    return undefined;
  }

  if (!model.efforts.includes(requested)) {
    throw new Error(`${model.id} does not support ${requested} effort.`);
  }

  return requested;
}

function readSampling(
  input: ClientProviderRequest,
  { temperatureMax, topPMin }: { temperatureMax: number; topPMin: number },
) {
  const temperature = readNumber(input.temperature, "temperature", 0, temperatureMax);
  const topP = readNumber(input.top_p, "top_p", topPMin, 1);

  if (temperature !== undefined && topP !== undefined) {
    throw new Error("Use either temperature or top_p, not both.");
  }

  return {
    temperature,
    topP,
  };
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractOpenAIOutputText(output: unknown) {
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

function extractAnthropicOutputText(output: unknown) {
  if (!isRecord(output) || !Array.isArray(output.content)) {
    return "";
  }

  const parts: string[] = [];

  for (const content of output.content) {
    if (
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string" &&
      content.text.trim()
    ) {
      parts.push(content.text.trim());
    }
  }

  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function readEnum<T extends string>(value: unknown, fieldName: string, options: readonly T[]) {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(`${fieldName} must be one of: ${options.join(", ")}.`);
  }

  return value as T;
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

function firstPresent(first: unknown, second: unknown) {
  return first === undefined || first === null || first === "" ? second : first;
}

function rejectProvided(value: unknown, message: string) {
  if (value !== "" && value !== null && value !== undefined) {
    throw new Error(message);
  }
}
