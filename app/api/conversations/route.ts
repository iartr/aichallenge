import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import { ConversationStoreError, listConversations } from "@/lib/conversations";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const conversations = await listConversations(user.login);

    return NextResponse.json({
      conversations,
    });
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof AuthConfigError || error instanceof ConversationStoreError) {
    return errorResponse(error.message, error.status);
  }

  return errorResponse("Conversation list failed.", 500);
}

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    {
      error: {
        message,
      },
    },
    { status },
  );
}
