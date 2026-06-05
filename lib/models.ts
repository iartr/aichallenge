export const PROVIDER_OPTIONS = ["openai", "anthropic"] as const;

export type ProviderOption = (typeof PROVIDER_OPTIONS)[number];

export const OPENAI_REASONING_EFFORTS = ["off", "none", "low", "medium", "high", "xhigh"] as const;
export const OPENAI_REASONING_SUMMARIES = ["off", "auto", "concise", "detailed"] as const;
export const SAMPLING_CONTROLS = ["temperature", "top_p", "top_k"] as const;
export const OPENAI_SAMPLING_CONTROLS = ["temperature", "top_p"] as const;
export const TEXT_VERBOSITIES = ["low", "medium", "high"] as const;
export const ANTHROPIC_THINKING_MODES = ["disabled", "adaptive", "manual"] as const;
export const ANTHROPIC_THINKING_DISPLAYS = ["summarized", "omitted"] as const;
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type OpenAIReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];
export type OpenAIReasoningSummary = (typeof OPENAI_REASONING_SUMMARIES)[number];
export type SamplingControl = (typeof SAMPLING_CONTROLS)[number];
export type OpenAISamplingControl = (typeof OPENAI_SAMPLING_CONTROLS)[number];
export type TextVerbosity = (typeof TEXT_VERBOSITIES)[number];
export type AnthropicThinkingMode = (typeof ANTHROPIC_THINKING_MODES)[number];
export type AnthropicThinkingDisplay = (typeof ANTHROPIC_THINKING_DISPLAYS)[number];
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

type BaseModelOption = {
  id: string;
  label: string;
  provider: ProviderOption;
};

export type OpenAIModelOption = BaseModelOption & {
  provider: "openai";
  reasoningEfforts: readonly OpenAIReasoningEffort[];
  defaultReasoningEffort: OpenAIReasoningEffort;
  samplingControls: readonly OpenAISamplingControl[];
};

export type AnthropicModelOption = BaseModelOption & {
  provider: "anthropic";
  thinkingModes: readonly AnthropicThinkingMode[];
  defaultThinkingMode: AnthropicThinkingMode;
  efforts: readonly AnthropicEffort[];
  defaultEffort?: AnthropicEffort;
  samplingControls: readonly SamplingControl[];
  maxTokens: number;
};

export type ModelOption = OpenAIModelOption | AnthropicModelOption;

const OPENAI_BALANCED_EFFORTS = ["low", "medium", "high"] as const;
const OPENAI_EXPLICIT_BALANCED_EFFORTS = ["off", ...OPENAI_BALANCED_EFFORTS] as const;
const OPENAI_LATEST_EFFORTS = ["off", "none", "low", "medium", "high", "xhigh"] as const;
const OPENAI_DEFAULT_SAMPLING = ["temperature", "top_p"] as const;
const OPENAI_NO_SAMPLING = [] as const;
const ANTHROPIC_DEFAULT_SAMPLING = ["temperature", "top_p", "top_k"] as const;
const ANTHROPIC_NO_SAMPLING = [] as const;
const ANTHROPIC_NO_TOP_K_SAMPLING = ["temperature", "top_p"] as const;

export const MODEL_OPTIONS = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    reasoningEfforts: OPENAI_LATEST_EFFORTS,
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_NO_SAMPLING,
  },
  {
    id: "gpt-5.5-pro-2026-04-23",
    label: "GPT-5.5 Pro",
    provider: "openai",
    reasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_NO_SAMPLING,
  },
  {
    id: "gpt-5.5-2026-04-23",
    label: "GPT-5.5 snapshot",
    provider: "openai",
    reasoningEfforts: OPENAI_LATEST_EFFORTS,
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_NO_SAMPLING,
  },
  {
    id: "gpt-5.4-pro-2026-03-05",
    label: "GPT-5.4 Pro",
    provider: "openai",
    reasoningEfforts: ["off", "high"],
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_NO_SAMPLING,
  },
  {
    id: "gpt-5.4-2026-03-05",
    label: "GPT-5.4 snapshot",
    provider: "openai",
    reasoningEfforts: OPENAI_EXPLICIT_BALANCED_EFFORTS,
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_DEFAULT_SAMPLING,
  },
  {
    id: "gpt-5.4-mini-2026-03-17",
    label: "GPT-5.4 Mini",
    provider: "openai",
    reasoningEfforts: OPENAI_EXPLICIT_BALANCED_EFFORTS,
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_DEFAULT_SAMPLING,
  },
  {
    id: "gpt-5.4-nano-2026-03-17",
    label: "GPT-5.4 Nano",
    provider: "openai",
    reasoningEfforts: OPENAI_EXPLICIT_BALANCED_EFFORTS,
    defaultReasoningEffort: "off",
    samplingControls: OPENAI_DEFAULT_SAMPLING,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    thinkingModes: ["disabled", "adaptive"],
    defaultThinkingMode: "disabled",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    samplingControls: ANTHROPIC_NO_SAMPLING,
    maxTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    thinkingModes: ["disabled", "adaptive", "manual"],
    defaultThinkingMode: "adaptive",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
    samplingControls: ANTHROPIC_NO_TOP_K_SAMPLING,
    maxTokens: 64000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    thinkingModes: ["disabled", "manual"],
    defaultThinkingMode: "disabled",
    efforts: [],
    samplingControls: ANTHROPIC_DEFAULT_SAMPLING,
    maxTokens: 64000,
  },
] as const satisfies readonly ModelOption[];

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];

export function isKnownProvider(provider: string): provider is ProviderOption {
  return PROVIDER_OPTIONS.includes(provider as ProviderOption);
}

export function getModelsForProvider(provider: ProviderOption) {
  return MODEL_OPTIONS.filter((option) => option.provider === provider);
}

export function getModelOption(model: string): ModelOption | undefined {
  return MODEL_OPTIONS.find((option) => option.id === model);
}

export function isKnownModel(model: string): model is ModelId {
  return getModelOption(model) !== undefined;
}
