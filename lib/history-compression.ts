import {
  CHAT_AGENT_INSTRUCTIONS,
  DEFAULT_OPENAI_CHAT_MODEL,
  OpenAIChatAgent,
  type AgentChatMessage,
} from "./chat-agent";
import { countHistoryTokens, countTextTokens, type AgentTokenUsage } from "./token-usage";

export const KEEP_RECENT_MESSAGES = 10;
export const SUMMARY_BATCH_SIZE = 10;
export const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 600;

export const SUMMARIZER_INSTRUCTIONS = [
  "You maintain a running summary of a chat conversation. Merge the previous summary with the new messages into a single updated summary.",
  "Rules:",
  "- Preserve every concrete fact: names, numbers, dates, places, decisions, user preferences, and unresolved questions.",
  "- Drop greetings, filler, and pleasantries.",
  "- Write the summary in the same language the conversation is written in; if the language is ambiguous, use English.",
  "- Output only the summary text: short plain sentences or compact bullet lines, no preamble, no headings.",
  "- Keep it under 200 words.",
].join("\n");

export type CompressionState = {
  summary: string;
  summaryCoveredCount: number;
};

export type SummarizerUsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type CompressionPlan = {
  foldCount: number;
  messagesToFold: AgentChatMessage[];
};

export type CompressionOptions = {
  keepRecent?: number;
  batchSize?: number;
};

export type SummarizerResult = {
  summary: string;
  usage: AgentTokenUsage;
  model: string;
};

export type SummarizeFn = (input: {
  previousSummary: string;
  messages: AgentChatMessage[];
}) => Promise<SummarizerResult>;

export type CompressionStepResult = {
  state: CompressionState;
  sentMessages: AgentChatMessage[];
  instructions: string;
  summarizerUsage: AgentTokenUsage | null;
  summarizerError: string | null;
};

export type CompressionReport = {
  enabled: boolean;
  summary: string;
  summaryTokens: number;
  coveredMessageCount: number;
  sentMessageCount: number;
  sentHistoryTokens: number;
  fullHistoryTokens: number;
  savedTokens: number;
  savedPercent: number;
  summarizer: SummarizerUsageTotals | null;
  summarizerTotals: SummarizerUsageTotals;
  netSavedTokens: number;
  summarizerError: string | null;
};

export function planCompression(
  messages: AgentChatMessage[],
  state: CompressionState,
  { keepRecent = KEEP_RECENT_MESSAGES, batchSize = SUMMARY_BATCH_SIZE }: CompressionOptions = {},
): CompressionPlan {
  const covered = clampCoveredCount(state.summaryCoveredCount, messages.length);
  const uncovered = messages.length - covered;
  const foldable = uncovered - keepRecent;
  const foldCount = foldable >= batchSize ? Math.floor(foldable / batchSize) * batchSize : 0;

  return {
    foldCount,
    messagesToFold: foldCount > 0 ? messages.slice(covered, covered + foldCount) : [],
  };
}

export function buildCompressedInstructions(baseInstructions: string, summary: string) {
  const trimmedSummary = summary.trim();

  if (!trimmedSummary) {
    return baseInstructions;
  }

  return `${baseInstructions}\n\nSummary of the earlier part of this conversation (older messages were omitted, rely on this summary for their content):\n${trimmedSummary}`;
}

export function buildSummarizerInput(previousSummary: string, messagesToFold: AgentChatMessage[]) {
  const summaryBlock = previousSummary.trim() || "(none)";
  const transcript = messagesToFold.map((message) => `${message.role}: ${message.content}`).join("\n");

  return `Previous summary:\n${summaryBlock}\n\nNew messages to fold into the summary:\n${transcript}`;
}

export async function summarizeMessages({
  apiKey,
  previousSummary,
  messages,
  model,
  fetcher,
  maxOutputTokens = DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
}: {
  apiKey: string;
  previousSummary: string;
  messages: AgentChatMessage[];
  model?: string;
  fetcher?: typeof fetch;
  maxOutputTokens?: number;
}): Promise<SummarizerResult> {
  const resolvedModel =
    model || process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL;
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
        content: buildSummarizerInput(previousSummary, messages),
      },
    ],
    { instructions: SUMMARIZER_INSTRUCTIONS },
  );

  return {
    summary: result.answer,
    usage: result.usage,
    model: result.model,
  };
}

export async function compressHistory(
  messages: AgentChatMessage[],
  state: CompressionState,
  summarize: SummarizeFn,
  options: CompressionOptions & { baseInstructions?: string } = {},
): Promise<CompressionStepResult> {
  const baseInstructions = options.baseInstructions ?? CHAT_AGENT_INSTRUCTIONS;
  const clampedState: CompressionState = {
    summary: state.summary,
    summaryCoveredCount: clampCoveredCount(state.summaryCoveredCount, messages.length),
  };
  const plan = planCompression(messages, clampedState, options);

  let nextState = clampedState;
  let summarizerUsage: AgentTokenUsage | null = null;
  let summarizerError: string | null = null;

  if (plan.foldCount > 0) {
    try {
      const result = await summarize({
        previousSummary: clampedState.summary,
        messages: plan.messagesToFold,
      });

      nextState = {
        summary: result.summary,
        summaryCoveredCount: clampedState.summaryCoveredCount + plan.foldCount,
      };
      summarizerUsage = result.usage;
    } catch (error) {
      // Degrade gracefully: keep the old summary state and send the full
      // uncovered tail; the fold retries on the next turn.
      summarizerError = error instanceof Error ? error.message : "Summarizer failed.";
    }
  }

  return {
    state: nextState,
    sentMessages: messages.slice(nextState.summaryCoveredCount),
    instructions: buildCompressedInstructions(baseInstructions, nextState.summary),
    summarizerUsage,
    summarizerError,
  };
}

export function buildCompressionReport({
  enabled,
  allMessages,
  sentMessages,
  instructions,
  state,
  summarizerUsage,
  summarizerTotals,
  summarizerError,
}: {
  enabled: boolean;
  allMessages: AgentChatMessage[];
  sentMessages: AgentChatMessage[];
  instructions: string;
  state: CompressionState;
  summarizerUsage: AgentTokenUsage | null;
  summarizerTotals: SummarizerUsageTotals;
  summarizerError: string | null;
}): CompressionReport {
  const sentHistoryTokens = countHistoryTokens(sentMessages, instructions);
  const fullHistoryTokens = countHistoryTokens(allMessages, CHAT_AGENT_INSTRUCTIONS);
  const savedTokens = Math.max(fullHistoryTokens - sentHistoryTokens, 0);
  const summarizer = summarizerUsage ? addSummarizerUsage(emptySummarizerUsageTotals(), summarizerUsage) : null;

  return {
    enabled,
    summary: state.summary,
    summaryTokens: state.summary ? countTextTokens(state.summary) : 0,
    coveredMessageCount: state.summaryCoveredCount,
    sentMessageCount: sentMessages.length,
    sentHistoryTokens,
    fullHistoryTokens,
    savedTokens,
    savedPercent: fullHistoryTokens > 0 ? Math.round((savedTokens / fullHistoryTokens) * 1000) / 10 : 0,
    summarizer,
    summarizerTotals,
    netSavedTokens: savedTokens - (summarizer?.totalTokens ?? 0),
    summarizerError,
  };
}

export function emptySummarizerUsageTotals(): SummarizerUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function normalizeSummarizerUsage(value: unknown): SummarizerUsageTotals {
  if (typeof value !== "object" || value === null) {
    return emptySummarizerUsageTotals();
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

export function addSummarizerUsage(totals: SummarizerUsageTotals, usage: AgentTokenUsage): SummarizerUsageTotals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + usage.historyTokens,
    outputTokens: totals.outputTokens + usage.responseTokens,
    totalTokens: totals.totalTokens + usage.totalTokens,
    costUsd: roundUsd(totals.costUsd + usage.estimatedCostUsd),
  };
}

function clampCoveredCount(value: number, messageCount: number) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.min(Math.floor(value), messageCount);
}

function readNonNegativeNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
