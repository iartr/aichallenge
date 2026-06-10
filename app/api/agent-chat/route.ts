import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import { ChatAgentError, OpenAIChatAgent, normalizeAgentMessages } from "@/lib/chat-agent";
import {
  ConversationStoreError,
  createConversation,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
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
    const { conversationId, message } = readChatRequest(body);
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
    const agent = new OpenAIChatAgent({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_CHAT_MODEL,
    });
    const result = await agent.respond(messages);
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
        usage: buildMessageTokenUsage(result.usage, result.usage.responseTokens),
      },
    ];
    const savedConversation = conversation
      ? await updateConversation(user.login, conversation.id, savedMessages)
      : await createConversation(user.login, savedMessages);

    if (!savedConversation) {
      return errorResponse("Conversation not found.", 404);
    }

    return NextResponse.json({
      ...result,
      conversation: savedConversation,
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

  return {
    conversationId: typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : null,
    message,
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
