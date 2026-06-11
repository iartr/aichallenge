import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import {
  CHAT_AGENT_INSTRUCTIONS,
  ChatAgentError,
  OpenAIChatAgent,
  normalizeAgentMessages,
} from "@/lib/chat-agent";
import {
  ConversationStoreError,
  createConversation,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
import {
  addSummarizerUsage,
  buildCompressionReport,
  compressHistory,
  emptySummarizerUsageTotals,
  summarizeMessages,
  type CompressionStepResult,
} from "@/lib/history-compression";
import { buildMessageTokenUsage, type AgentTokenUsage } from "@/lib/token-usage";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 8000;

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
    const { conversationId, message, compression } = readChatRequest(body);
    const conversation = conversationId ? await getConversation(user.login, conversationId) : null;

    if (conversationId && !conversation) {
      return errorResponse("Conversation not found.", 404);
    }

    const messages = normalizeAgentMessages([
      ...(conversation?.messages ?? []),
      {
        role: "user",
        content: message,
      },
    ]);
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const state = {
      summary: conversation?.summary ?? "",
      summaryCoveredCount: conversation?.summaryCoveredCount ?? 0,
    };
    const summarizerTotals = conversation?.summarizerUsage ?? emptySummarizerUsageTotals();
    const step: CompressionStepResult = compression
      ? await compressHistory(messages, state, ({ previousSummary, messages: messagesToFold }) =>
          summarizeMessages({ apiKey, previousSummary, messages: messagesToFold }),
        )
      : {
          state,
          sentMessages: messages,
          instructions: CHAT_AGENT_INSTRUCTIONS,
          summarizerUsage: null,
          summarizerError: null,
        };
    const agent = new OpenAIChatAgent({
      apiKey,
      model: process.env.OPENAI_CHAT_MODEL,
    });
    const result = await agent.respond(step.sentMessages, { instructions: step.instructions });
    const newSummarizerTotals = step.summarizerUsage
      ? addSummarizerUsage(summarizerTotals, step.summarizerUsage)
      : summarizerTotals;
    const compressionReport = buildCompressionReport({
      enabled: compression,
      allMessages: messages,
      sentMessages: step.sentMessages,
      instructions: step.instructions,
      state: step.state,
      summarizerUsage: step.summarizerUsage,
      summarizerTotals: newSummarizerTotals,
      summarizerError: step.summarizerError,
    });
    const latestUserMessage = messages[messages.length - 1] ?? {
      role: "user" as const,
      content: message,
    };
    const savedMessages = [
      ...messages.slice(0, -1),
      {
        ...latestUserMessage,
        usage: buildMessageTokenUsage(result.usage, result.usage.currentRequestTokens),
      },
      {
        role: "assistant" as const,
        content: result.answer,
        usage: {
          ...buildMessageTokenUsage(result.usage, result.usage.responseTokens),
          ...(compression ? { savedTokens: compressionReport.savedTokens } : {}),
        },
      },
    ];
    const savedConversation = conversation
      ? await updateConversation(
          user.login,
          conversation.id,
          savedMessages,
          compression && step.summarizerUsage
            ? {
                summary: step.state.summary,
                summaryCoveredCount: step.state.summaryCoveredCount,
                summarizerUsage: newSummarizerTotals,
              }
            : undefined,
        )
      : await createConversation(user.login, savedMessages);

    if (!savedConversation) {
      return errorResponse("Conversation not found.", 404);
    }

    return NextResponse.json({
      ...result,
      conversation: savedConversation,
      compression: compressionReport,
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

  if (body.compression !== undefined && body.compression !== null && typeof body.compression !== "boolean") {
    throw new ChatAgentError("compression must be a boolean.");
  }

  return {
    conversationId: typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : null,
    message,
    compression: body.compression ?? true,
  };
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
