import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export type TokenCountMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TokenFailureMode = "preflight_context_overflow" | "provider_context_overflow" | "provider_error";

export type AgentTokenUsage = {
  currentRequestTokens: number;
  historyTokens: number;
  responseTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
  remainingContextTokens: number;
  estimatedCostUsd: number;
  failureMode: TokenFailureMode | null;
  cachedInputTokens: number;
  reasoningTokens: number;
  isEstimate: boolean;
};

export type AgentMessageTokenUsage = AgentTokenUsage & {
  tokens: number;
};

export type OpenAIProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

type TokenCostInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

type TokenUsageEstimateInput = {
  messages: TokenCountMessage[];
  instructions: string;
  model: string;
  maxOutputTokens: number;
  responseText?: string;
};

const encoder = new Tiktoken(o200kBase);
const TOKENS_PER_MESSAGE = 4;
const RESPONSE_FORMAT_OVERHEAD = 3;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
const GPT_5_4_CONTEXT_WINDOW_TOKENS = 1_050_000;
const ONE_MILLION = 1_000_000;

const PRICING_BY_MODEL = [
  {
    pattern: /^gpt-5\.5(?:-|$)/,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  {
    pattern: /^gpt-5\.4-mini(?:-|$)/,
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  {
    pattern: /^gpt-5\.4(?:-|$)/,
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
] as const;

const FALLBACK_PRICING = PRICING_BY_MODEL[1];

export function countTextTokens(text: string) {
  return encoder.encode(text).length;
}

export function countMessageTokens(message: TokenCountMessage) {
  return TOKENS_PER_MESSAGE + countTextTokens(message.role) + countTextTokens(message.content);
}

export function countHistoryTokens(messages: TokenCountMessage[], instructions: string) {
  return (
    RESPONSE_FORMAT_OVERHEAD +
    countTextTokens(instructions) +
    messages.reduce((total, message) => total + countMessageTokens(message), 0)
  );
}

export function getContextWindowTokens(model: string, override = process.env.OPENAI_CONTEXT_WINDOW_TOKENS) {
  const overrideValue = readPositiveInteger(override);

  if (overrideValue) {
    return overrideValue;
  }

  if (/^gpt-5\.4(?:-|$)/.test(model) && !/^gpt-5\.4-(?:mini|nano)(?:-|$)/.test(model)) {
    return GPT_5_4_CONTEXT_WINDOW_TOKENS;
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function estimateTokenCostUsd({ model, inputTokens, outputTokens, cachedInputTokens = 0 }: TokenCostInput) {
  const pricing = PRICING_BY_MODEL.find((entry) => entry.pattern.test(model)) ?? FALLBACK_PRICING;
  const safeCachedInputTokens = Math.min(Math.max(cachedInputTokens, 0), Math.max(inputTokens, 0));
  const nonCachedInputTokens = Math.max(inputTokens - safeCachedInputTokens, 0);
  const cost =
    (nonCachedInputTokens * pricing.inputUsdPerMillion +
      safeCachedInputTokens * pricing.cachedInputUsdPerMillion +
      Math.max(outputTokens, 0) * pricing.outputUsdPerMillion) /
    ONE_MILLION;

  return roundUsd(cost);
}

export function buildTokenUsageEstimate({
  messages,
  instructions,
  model,
  maxOutputTokens,
  responseText = "",
}: TokenUsageEstimateInput): AgentTokenUsage {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const currentRequestTokens = latestUserMessage ? countTextTokens(latestUserMessage.content) : 0;
  const historyTokens = countHistoryTokens(messages, instructions);
  const responseTokens = responseText ? countTextTokens(responseText) : 0;
  const totalTokens = historyTokens + responseTokens;
  const contextWindowTokens = getContextWindowTokens(model);

  return {
    currentRequestTokens,
    historyTokens,
    responseTokens,
    totalTokens,
    contextWindowTokens,
    remainingContextTokens: Math.max(contextWindowTokens - Math.max(totalTokens, historyTokens + maxOutputTokens), 0),
    estimatedCostUsd: estimateTokenCostUsd({
      model,
      inputTokens: historyTokens,
      outputTokens: responseTokens,
    }),
    failureMode: null,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    isEstimate: true,
  };
}

export function applyProviderUsage(estimate: AgentTokenUsage, providerUsage: OpenAIProviderUsage, model: string) {
  const historyTokens = providerUsage.inputTokens;
  const responseTokens = providerUsage.outputTokens;
  const totalTokens = providerUsage.totalTokens || historyTokens + responseTokens;

  return {
    ...estimate,
    historyTokens,
    responseTokens,
    totalTokens,
    remainingContextTokens: Math.max(estimate.contextWindowTokens - totalTokens, 0),
    estimatedCostUsd: estimateTokenCostUsd({
      model,
      inputTokens: historyTokens,
      outputTokens: responseTokens,
      cachedInputTokens: providerUsage.cachedInputTokens,
    }),
    cachedInputTokens: providerUsage.cachedInputTokens,
    reasoningTokens: providerUsage.reasoningTokens,
    isEstimate: false,
  };
}

export function markTokenFailure(usage: AgentTokenUsage, failureMode: TokenFailureMode): AgentTokenUsage {
  return {
    ...usage,
    failureMode,
  };
}

export function buildMessageTokenUsage(usage: AgentTokenUsage, tokenCount: number): AgentMessageTokenUsage {
  return {
    ...usage,
    tokens: tokenCount,
  };
}

export function normalizeMessageTokenUsage(value: unknown): AgentMessageTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tokens = readNonNegativeNumber(value.tokens);
  const totalTokens = readNonNegativeNumber(value.totalTokens);
  const estimatedCostUsd = readNonNegativeNumber(value.estimatedCostUsd);
  const contextWindowTokens = readNonNegativeNumber(value.contextWindowTokens);
  const remainingContextTokens = readNonNegativeNumber(value.remainingContextTokens);
  const currentRequestTokens = readNonNegativeNumber(value.currentRequestTokens);
  const historyTokens = readNonNegativeNumber(value.historyTokens);
  const responseTokens = readNonNegativeNumber(value.responseTokens);
  const cachedInputTokens = readNonNegativeNumber(value.cachedInputTokens);
  const reasoningTokens = readNonNegativeNumber(value.reasoningTokens);

  if (tokens === undefined || totalTokens === undefined || estimatedCostUsd === undefined) {
    return undefined;
  }

  return {
    tokens,
    currentRequestTokens: currentRequestTokens ?? 0,
    historyTokens: historyTokens ?? totalTokens,
    responseTokens: responseTokens ?? 0,
    totalTokens,
    estimatedCostUsd,
    contextWindowTokens: contextWindowTokens ?? 0,
    remainingContextTokens: remainingContextTokens ?? 0,
    failureMode:
      value.failureMode === "preflight_context_overflow" ||
      value.failureMode === "provider_context_overflow" ||
      value.failureMode === "provider_error"
        ? value.failureMode
        : null,
    cachedInputTokens: cachedInputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    isEstimate: value.isEstimate === true,
  };
}

export function readOpenAIProviderUsage(value: unknown): OpenAIProviderUsage | null {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return null;
  }

  const inputTokens = readNonNegativeNumber(value.usage.input_tokens);
  const outputTokens = readNonNegativeNumber(value.usage.output_tokens);
  const totalTokens = readNonNegativeNumber(value.usage.total_tokens);

  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return null;
  }

  const cachedInputTokens = isRecord(value.usage.input_tokens_details)
    ? (readNonNegativeNumber(value.usage.input_tokens_details.cached_tokens) ?? 0)
    : 0;
  const reasoningTokens = isRecord(value.usage.output_tokens_details)
    ? (readNonNegativeNumber(value.usage.output_tokens_details.reasoning_tokens) ?? 0)
    : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}

function readPositiveInteger(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const numberValue = Number(value);

  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function readNonNegativeNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
