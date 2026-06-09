import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import { ConversationStoreError, getConversation } from "@/lib/conversations";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = requireAuthenticatedUser(request);
    const { id } = await context.params;
    const conversation = await getConversation(user.login, id);

    if (!conversation) {
      return errorResponse("Conversation not found.", 404);
    }

    return NextResponse.json({
      conversation,
    });
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof AuthConfigError || error instanceof ConversationStoreError) {
    return errorResponse(error.message, error.status);
  }

  return errorResponse("Conversation load failed.", 500);
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
