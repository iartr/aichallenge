import { NextResponse } from "next/server";
import { ChatAgentError, OpenAIChatAgent, normalizeAgentMessages } from "@/lib/chat-agent";
import { validateSecret } from "@/lib/provider-response";

export const runtime = "nodejs";

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

  if (!process.env.SECRET) {
    return NextResponse.json(
      {
        error: {
          message: "SECRET is not configured.",
        },
      },
      { status: 500 },
    );
  }

  if (!isRecord(body) || !validateSecret(body.secret, process.env.SECRET)) {
    return NextResponse.json(
      {
        error: {
          message: "Invalid secret.",
        },
      },
      { status: 401 },
    );
  }

  try {
    const messages = normalizeAgentMessages(body.messages);
    const agent = new OpenAIChatAgent({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: process.env.OPENAI_CHAT_MODEL,
    });
    const result = await agent.respond(messages);

    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof ChatAgentError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Chat agent failed.";

    return NextResponse.json(
      {
        error: {
          message,
        },
      },
      { status },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
