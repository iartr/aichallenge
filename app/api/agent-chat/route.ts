import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import {
  CHAT_AGENT_INSTRUCTIONS,
  ChatAgentError,
  OpenAIChatAgent,
  normalizeAgentMessages,
  type AgentChatMessage,
} from "@/lib/chat-agent";
import {
  ConversationStoreError,
  createConversation,
  getConversation,
  updateConversation,
  type ConversationUpdateState,
} from "@/lib/conversations";
import {
  addSummarizerUsage,
  buildCompressionReport,
  compressHistory,
  emptySummarizerUsageTotals,
  summarizeMessages,
} from "@/lib/history-compression";
import {
  CONTEXT_STRATEGIES,
  DEFAULT_CONTEXT_STRATEGY,
  DEFAULT_WINDOW_SIZE,
  addFactsUsage,
  applySlidingWindow,
  buildFactsStep,
  buildStrategyReport,
  emptyFactsUsageTotals,
  extractFacts,
  normalizeWindowSize,
  type ContextStrategy,
  type FactsState,
  type StrategyBranchInfo,
} from "@/lib/context-strategies";
import {
  ensureBranchingState,
  getActiveBranch,
  normalizeBranchingState,
  setActiveBranchMessages,
  syncCanonicalMessages,
} from "@/lib/branching";
import { buildMessageTokenUsage, type AgentTokenUsage } from "@/lib/token-usage";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 8000;

type StrategyStep = {
  sentMessages: AgentChatMessage[];
  instructions: string;
  helperUsage: AgentTokenUsage | null;
  helperError: string | null;
};

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const user = requireAuthenticatedUser(request);
    const { conversationId, message, strategy, windowSize } = readChatRequest(body);
    const conversation = conversationId ? await getConversation(user.login, conversationId) : null;

    if (conversationId && !conversation) {
      return errorResponse("Conversation not found.", 404);
    }

    const apiKey = process.env.OPENAI_API_KEY ?? "";

    // Determine the working history. Branching runs the active branch's full
    // history; every other strategy works from the canonical message list.
    let branchingState = normalizeBranchingState(conversation?.branches);
    let workingHistory = conversation?.messages ?? [];

    if (strategy === "branching") {
      branchingState = ensureBranchingState(branchingState, workingHistory);
      workingHistory = getActiveBranch(branchingState)?.messages ?? workingHistory;
    }

    const messages = normalizeAgentMessages([...workingHistory, { role: "user", content: message }]);

    // Carry every strategy's persisted state forward; only the active strategy mutates its own.
    let nextSummaryState = {
      summary: conversation?.summary ?? "",
      summaryCoveredCount: conversation?.summaryCoveredCount ?? 0,
    };
    let summarizerTotals = conversation?.summarizerUsage ?? emptySummarizerUsageTotals();
    let nextFactsState: FactsState = conversation?.factsState ?? { facts: [], factsCoveredCount: 0 };
    let factsTotals = conversation?.factsUsage ?? emptyFactsUsageTotals();

    let step: StrategyStep;

    switch (strategy) {
      case "sliding_window":
        step = {
          sentMessages: applySlidingWindow(messages, windowSize),
          instructions: CHAT_AGENT_INSTRUCTIONS,
          helperUsage: null,
          helperError: null,
        };
        break;
      case "facts": {
        const factsStep = await buildFactsStep(
          messages,
          nextFactsState,
          ({ previousFacts, messages: messagesToFold }) =>
            extractFacts({ apiKey, previousFacts, messages: messagesToFold }),
          { windowSize },
        );

        nextFactsState = factsStep.state;

        if (factsStep.factsUsage) {
          factsTotals = addFactsUsage(factsTotals, factsStep.factsUsage);
        }

        step = {
          sentMessages: factsStep.sentMessages,
          instructions: factsStep.instructions,
          helperUsage: factsStep.factsUsage,
          helperError: factsStep.factsError,
        };
        break;
      }
      case "summary": {
        const compressionStep = await compressHistory(
          messages,
          nextSummaryState,
          ({ previousSummary, messages: messagesToFold }) =>
            summarizeMessages({ apiKey, previousSummary, messages: messagesToFold }),
        );

        nextSummaryState = compressionStep.state;

        if (compressionStep.summarizerUsage) {
          summarizerTotals = addSummarizerUsage(summarizerTotals, compressionStep.summarizerUsage);
        }

        step = {
          sentMessages: compressionStep.sentMessages,
          instructions: compressionStep.instructions,
          helperUsage: compressionStep.summarizerUsage,
          helperError: compressionStep.summarizerError,
        };
        break;
      }
      case "full":
      case "branching":
      default:
        step = {
          sentMessages: messages,
          instructions: CHAT_AGENT_INSTRUCTIONS,
          helperUsage: null,
          helperError: null,
        };
        break;
    }

    const agent = new OpenAIChatAgent({
      apiKey,
      model: process.env.OPENAI_CHAT_MODEL,
    });
    const result = await agent.respond(step.sentMessages, { instructions: step.instructions });

    const branchInfo: StrategyBranchInfo | null =
      strategy === "branching"
        ? (() => {
            const active = getActiveBranch(branchingState);
            return active ? { activeId: active.id, activeName: active.name, count: messages.length + 1 } : null;
          })()
        : null;

    const report = buildStrategyReport({
      strategy,
      windowSize,
      allMessages: messages,
      sentMessages: step.sentMessages,
      instructions: step.instructions,
      facts: strategy === "facts" ? nextFactsState.facts : (conversation?.facts ?? []),
      summary: strategy === "summary" ? nextSummaryState.summary : (conversation?.summary ?? ""),
      helperUsage: step.helperUsage,
      helperTotals:
        strategy === "facts" ? factsTotals : strategy === "summary" ? summarizerTotals : null,
      branch: branchInfo,
      error: step.helperError,
    });

    const latestUserMessage = messages[messages.length - 1] ?? {
      role: "user" as const,
      content: message,
    };
    const savedMessages: AgentChatMessage[] = [
      ...messages.slice(0, -1),
      {
        ...latestUserMessage,
        usage: buildMessageTokenUsage(result.usage, result.usage.currentRequestTokens),
      },
      {
        role: "assistant",
        content: result.answer,
        usage: {
          ...buildMessageTokenUsage(result.usage, result.usage.responseTokens),
          ...(strategy !== "full" ? { savedTokens: report.savedTokens } : {}),
        },
      },
    ];

    // Keep the active branch synced with the canonical thread whenever the
    // conversation has been branched (even if chatting under another strategy).
    let canonicalMessages = savedMessages;
    let nextBranches = branchingState;

    if (strategy === "branching" || branchingState.list.length > 0) {
      nextBranches = setActiveBranchMessages(branchingState, savedMessages);
      canonicalMessages = syncCanonicalMessages(nextBranches);
    }

    const updateState: ConversationUpdateState = {
      summary: nextSummaryState.summary,
      summaryCoveredCount: nextSummaryState.summaryCoveredCount,
      summarizerUsage: summarizerTotals,
      contextStrategy: strategy,
      facts: nextFactsState,
      factsUsage: factsTotals,
      branches: nextBranches,
    };

    let savedConversation = conversation
      ? await updateConversation(user.login, conversation.id, canonicalMessages, updateState)
      : await createConversation(user.login, canonicalMessages, strategy);

    if (!savedConversation) {
      return errorResponse("Conversation not found.", 404);
    }

    // A brand-new conversation is created without extension state; persist the
    // facts/branches produced on this first turn so they survive a reload.
    if (!conversation && (strategy === "facts" || strategy === "branching")) {
      savedConversation =
        (await updateConversation(user.login, savedConversation.id, canonicalMessages, updateState)) ??
        savedConversation;
    }

    return NextResponse.json({
      ...result,
      conversation: savedConversation,
      strategy: report,
      ...(strategy === "summary"
        ? {
            compression: buildCompressionReport({
              enabled: true,
              allMessages: messages,
              sentMessages: step.sentMessages,
              instructions: step.instructions,
              state: nextSummaryState,
              summarizerUsage: step.helperUsage,
              summarizerTotals,
              summarizerError: step.helperError,
            }),
          }
        : {}),
    });
  } catch (error) {
    const status =
      error instanceof ChatAgentError || error instanceof AuthConfigError || error instanceof ConversationStoreError
        ? error.status
        : 500;
    const message = error instanceof Error ? error.message : "Chat agent failed.";
    const usage = error instanceof ChatAgentError ? error.usage : undefined;

    return errorResponse(message, status, usage);
  }
}

function readChatRequest(body: unknown) {
  if (!isRecord(body)) {
    throw new ChatAgentError("Request body must be an object.");
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    throw new ChatAgentError("message is required.");
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatAgentError(`message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

  if (body.conversationId !== undefined && body.conversationId !== null && typeof body.conversationId !== "string") {
    throw new ChatAgentError("conversationId must be a string.");
  }

  if (body.windowSize !== undefined && body.windowSize !== null && typeof body.windowSize !== "number") {
    throw new ChatAgentError("windowSize must be a number.");
  }

  return {
    conversationId:
      typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : null,
    message,
    strategy: readStrategy(body),
    windowSize: normalizeWindowSize(body.windowSize, DEFAULT_WINDOW_SIZE),
  };
}

function readStrategy(body: Record<string, unknown>): ContextStrategy {
  if (typeof body.strategy === "string") {
    if (!(CONTEXT_STRATEGIES as string[]).includes(body.strategy)) {
      throw new ChatAgentError(`strategy must be one of ${CONTEXT_STRATEGIES.join(", ")}.`);
    }

    return body.strategy as ContextStrategy;
  }

  // Legacy day4 clients send a `compression` boolean instead of `strategy`.
  if (typeof body.compression === "boolean") {
    return body.compression ? "summary" : "full";
  }

  if (body.compression !== undefined && body.compression !== null) {
    throw new ChatAgentError("compression must be a boolean.");
  }

  return DEFAULT_CONTEXT_STRATEGY;
}

function errorResponse(message: string, status: number, usage?: AgentTokenUsage) {
  return NextResponse.json(
    {
      error: {
        message,
      },
      ...(usage ? { usage } : {}),
    },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
