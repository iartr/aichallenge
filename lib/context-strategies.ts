import {
  CHAT_AGENT_INSTRUCTIONS,
  DEFAULT_OPENAI_CHAT_MODEL,
  OpenAIChatAgent,
  type AgentChatMessage,
} from "./chat-agent";
import { countHistoryTokens, countTextTokens, type AgentTokenUsage } from "./token-usage";

export type ContextStrategy = "full" | "sliding_window" | "facts" | "branching" | "summary";

export const CONTEXT_STRATEGIES: ContextStrategy[] = [
  "full",
  "sliding_window",
  "facts",
  "branching",
  "summary",
];

export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = "full";
export const DEFAULT_WINDOW_SIZE = 6;
export const DEFAULT_FACTS_MAX_OUTPUT_TOKENS = 500;

// Closed key vocabulary keeps the block a key-value memory, not prose.
export type FactKey = "goal" | "constraints" | "preferences" | "decisions" | "agreements";
export const FACT_KEYS: FactKey[] = ["goal", "constraints", "preferences", "decisions", "agreements"];

export type FactItem = {
  key: FactKey;
  value: string;
};

export type FactsState = {
  facts: FactItem[];
  factsCoveredCount: number;
};

export type FactsUsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type FactsExtractorResult = {
  facts: FactItem[];
  usage: AgentTokenUsage;
  model: string;
};

export type FactsStepResult = {
  state: FactsState;
  sentMessages: AgentChatMessage[];
  instructions: string;
  factsUsage: AgentTokenUsage | null;
  factsError: string | null;
};

export type ExtractFactsFn = (input: {
  previousFacts: FactItem[];
  messages: AgentChatMessage[];
}) => Promise<FactsExtractorResult>;

export type StrategyBranchInfo = {
  activeId: string;
  activeName: string;
  count: number;
};

export type StrategyReport = {
  strategy: ContextStrategy;
  enabled: boolean;
  windowSize: number;
  sentMessageCount: number;
  droppedMessageCount: number;
  sentHistoryTokens: number;
  fullHistoryTokens: number;
  savedTokens: number;
  savedPercent: number;
  extraTokens: number;
  facts: FactItem[];
  factsTokens: number;
  summary: string;
  summaryTokens: number;
  helperUsage: FactsUsageTotals | null;
  helperTotals: FactsUsageTotals | null;
  netSavedTokens: number;
  branch: StrategyBranchInfo | null;
  error: string | null;
};

export const FACTS_EXTRACTOR_INSTRUCTIONS = [
  "You maintain a compact key-value memory of a chat conversation. Merge the previous facts with the new messages into a single updated facts object.",
  `Allowed keys (use only these): ${FACT_KEYS.join(", ")}.`,
  "Rules:",
  "- goal: what the user is trying to achieve. constraints: hard limits (budget, deadline, tech limits, prohibitions). preferences: soft wishes/style. decisions: choices already made. agreements: things both sides agreed on.",
  "- Return the COMPLETE updated facts, including unchanged values. Update values that changed, add new ones, never invent.",
  "- Each value is a short string. If several items share a key, join them with '; '.",
  "- Preserve concrete details: names, numbers, dates, places, tech, prohibitions.",
  "- Output ONLY a single JSON object mapping keys to string values. No prose, no markdown fences, no commentary.",
].join("\n");

export function normalizeContextStrategy(value: unknown): ContextStrategy {
  return typeof value === "string" && (CONTEXT_STRATEGIES as string[]).includes(value)
    ? (value as ContextStrategy)
    : DEFAULT_CONTEXT_STRATEGY;
}

export function normalizeWindowSize(value: unknown, fallback = DEFAULT_WINDOW_SIZE): number {
  const numberValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.max(1, Math.floor(numberValue));
}

/**
 * Sliding window: keep only the last N messages. A tail slice of an array whose
 * last element is the new user message always keeps that element last, so the
 * "last message must be user" invariant (normalizeAgentMessages) holds for n>=1.
 */
export function applySlidingWindow(messages: AgentChatMessage[], windowSize: number): AgentChatMessage[] {
  const n = Number.isFinite(windowSize) ? Math.max(1, Math.floor(windowSize)) : DEFAULT_WINDOW_SIZE;

  if (n >= messages.length) {
    return messages;
  }

  return messages.slice(messages.length - n);
}

export function renderFactsBlock(facts: FactItem[]): string {
  return facts
    .filter((fact) => fact.value.trim())
    .map((fact) => `- ${fact.key}: ${fact.value.trim()}`)
    .join("\n");
}

export function buildFactsInstructions(baseInstructions: string, facts: FactItem[]): string {
  const block = renderFactsBlock(facts);

  if (!block) {
    return baseInstructions;
  }

  return `${baseInstructions}\n\nKnown facts about this conversation (persistent key-value memory; older messages may be omitted, rely on these facts):\n${block}`;
}

export function buildFactsExtractorInput(previousFacts: FactItem[], messages: AgentChatMessage[]): string {
  const factsObject: Record<string, string> = {};

  for (const fact of previousFacts) {
    factsObject[fact.key] = fact.value;
  }

  const factsBlock = previousFacts.length ? JSON.stringify(factsObject, null, 0) : "{}";
  const transcript = messages.map((message) => `${message.role}: ${message.content}`).join("\n");

  return `Current facts (JSON):\n${factsBlock}\n\nNew messages to fold into the facts:\n${transcript}`;
}

export function coerceFactValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("; ");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

export function parseFactsJson(text: string, previousFacts: FactItem[] = []): FactItem[] {
  const parsed = extractJsonObject(text);

  if (!parsed) {
    return previousFacts;
  }

  const items: FactItem[] = [];

  for (const key of FACT_KEYS) {
    const value = coerceFactValue(parsed[key]);

    if (value) {
      items.push({ key, value });
    }
  }

  return items.length ? items : previousFacts;
}

export async function extractFacts({
  apiKey,
  previousFacts,
  messages,
  model,
  fetcher,
  maxOutputTokens = DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
}: {
  apiKey: string;
  previousFacts: FactItem[];
  messages: AgentChatMessage[];
  model?: string;
  fetcher?: typeof fetch;
  maxOutputTokens?: number;
}): Promise<FactsExtractorResult> {
  const resolvedModel =
    model || process.env.OPENAI_FACTS_MODEL || process.env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL;
  const agent = new OpenAIChatAgent({
    apiKey,
    model: resolvedModel,
    ...(fetcher ? { fetcher } : {}),
    maxOutputTokens,
  });
  const result = await agent.respond(
    [
      {
        role: "user",
        content: buildFactsExtractorInput(previousFacts, messages),
      },
    ],
    { instructions: FACTS_EXTRACTOR_INSTRUCTIONS },
  );

  return {
    facts: parseFactsJson(result.answer, previousFacts),
    usage: result.usage,
    model: result.model,
  };
}

/**
 * Facts step: extract/update facts FIRST (so the just-arrived user message is
 * captured this turn even when the window drops it), then send the facts block
 * plus the last N messages. Degrades gracefully if the extractor call fails.
 */
export async function buildFactsStep(
  messages: AgentChatMessage[],
  state: FactsState,
  extract: ExtractFactsFn,
  options: { windowSize?: number; baseInstructions?: string } = {},
): Promise<FactsStepResult> {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const baseInstructions = options.baseInstructions ?? CHAT_AGENT_INSTRUCTIONS;
  const covered = clampCovered(state.factsCoveredCount, messages.length);
  const newMessages = messages.slice(covered);

  let nextState: FactsState = { facts: state.facts, factsCoveredCount: covered };
  let factsUsage: AgentTokenUsage | null = null;
  let factsError: string | null = null;

  if (newMessages.length > 0) {
    try {
      const result = await extract({ previousFacts: state.facts, messages: newMessages });

      nextState = { facts: result.facts, factsCoveredCount: messages.length };
      factsUsage = result.usage;
    } catch (error) {
      // Keep the existing facts and send the windowed tail; retry next turn.
      factsError = error instanceof Error ? error.message : "Facts extractor failed.";
    }
  }

  return {
    state: nextState,
    sentMessages: applySlidingWindow(messages, windowSize),
    instructions: buildFactsInstructions(baseInstructions, nextState.facts),
    factsUsage,
    factsError,
  };
}

export function buildStrategyReport({
  strategy,
  windowSize = DEFAULT_WINDOW_SIZE,
  allMessages,
  sentMessages,
  instructions,
  facts = [],
  summary = "",
  helperUsage = null,
  helperTotals = null,
  branch = null,
  error = null,
}: {
  strategy: ContextStrategy;
  windowSize?: number;
  allMessages: AgentChatMessage[];
  sentMessages: AgentChatMessage[];
  instructions: string;
  facts?: FactItem[];
  summary?: string;
  helperUsage?: AgentTokenUsage | null;
  helperTotals?: FactsUsageTotals | null;
  branch?: StrategyBranchInfo | null;
  error?: string | null;
}): StrategyReport {
  const sentHistoryTokens = countHistoryTokens(sentMessages, instructions);
  const fullHistoryTokens = countHistoryTokens(allMessages, CHAT_AGENT_INSTRUCTIONS);
  const savedTokens = Math.max(fullHistoryTokens - sentHistoryTokens, 0);
  const extraTokens = Math.max(countTextTokens(instructions) - countTextTokens(CHAT_AGENT_INSTRUCTIONS), 0);
  const helper = helperUsage ? addFactsUsage(emptyFactsUsageTotals(), helperUsage) : null;

  return {
    strategy,
    enabled: strategy !== "full",
    windowSize,
    sentMessageCount: sentMessages.length,
    droppedMessageCount: Math.max(allMessages.length - sentMessages.length, 0),
    sentHistoryTokens,
    fullHistoryTokens,
    savedTokens,
    savedPercent: fullHistoryTokens > 0 ? Math.round((savedTokens / fullHistoryTokens) * 1000) / 10 : 0,
    extraTokens,
    facts,
    factsTokens: facts.length ? countTextTokens(renderFactsBlock(facts)) : 0,
    summary,
    summaryTokens: summary ? countTextTokens(summary) : 0,
    helperUsage: helper,
    helperTotals,
    netSavedTokens: savedTokens - (helper?.totalTokens ?? 0),
    branch,
    error,
  };
}

export function emptyFactsUsageTotals(): FactsUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function addFactsUsage(totals: FactsUsageTotals, usage: AgentTokenUsage): FactsUsageTotals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + usage.historyTokens,
    outputTokens: totals.outputTokens + usage.responseTokens,
    totalTokens: totals.totalTokens + usage.totalTokens,
    costUsd: roundUsd(totals.costUsd + usage.estimatedCostUsd),
  };
}

export function normalizeFactsUsage(value: unknown): FactsUsageTotals {
  if (typeof value !== "object" || value === null) {
    return emptyFactsUsageTotals();
  }

  const record = value as Record<string, unknown>;

  return {
    calls: readNonNegativeNumber(record.calls),
    inputTokens: readNonNegativeNumber(record.inputTokens),
    outputTokens: readNonNegativeNumber(record.outputTokens),
    totalTokens: readNonNegativeNumber(record.totalTokens),
    costUsd: readNonNegativeNumber(record.costUsd),
  };
}

export function normalizeFacts(value: unknown): FactItem[] {
  const rawItems = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  const items: FactItem[] = [];

  for (const entry of rawItems) {
    if (!isRecord(entry)) {
      continue;
    }

    const key = entry.key;
    const factValue = coerceFactValue(entry.value);

    if (typeof key === "string" && (FACT_KEYS as string[]).includes(key) && factValue) {
      items.push({ key: key as FactKey, value: factValue });
    }
  }

  return items;
}

export function normalizeFactsState(value: unknown): FactsState {
  const facts = normalizeFacts(value);
  const coveredCount = isRecord(value) ? readNonNegativeNumber(value.coveredCount) : 0;

  return {
    facts,
    factsCoveredCount: coveredCount,
  };
}

export function serializeFactsState(state: FactsState, usage: FactsUsageTotals) {
  return {
    items: state.facts,
    coveredCount: state.factsCoveredCount,
    usage,
  };
}

function clampCovered(value: number, messageCount: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.min(Math.floor(value), messageCount);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = stripCodeFences(text).trim();
  const direct = tryParseObject(trimmed);

  if (direct) {
    return direct;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);

  return match ? tryParseObject(match[0]) : null;
}

function stripCodeFences(text: string) {
  return text.replace(/```(?:json)?/gi, "");
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readNonNegativeNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
