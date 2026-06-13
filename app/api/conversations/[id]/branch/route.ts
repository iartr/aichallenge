import { NextResponse } from "next/server";
import { AuthConfigError, requireAuthenticatedUser } from "@/lib/auth";
import {
  ConversationStoreError,
  extensionStateFromRecord,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
import {
  BranchingError,
  branchSummaries,
  ensureBranchingState,
  forkBranch,
  normalizeBranchingState,
  setCheckpoint,
  switchBranch,
  syncCanonicalMessages,
  type BranchingState,
} from "@/lib/branching";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  try {
    const user = requireAuthenticatedUser(request);
    const { id } = await context.params;
    const conversation = await getConversation(user.login, id);

    if (!conversation) {
      return errorResponse("Conversation not found.", 404);
    }

    if (!isRecord(body)) {
      return errorResponse("Request body must be an object.", 400);
    }

    const state = ensureBranchingState(normalizeBranchingState(conversation.branches), conversation.messages);
    const nextState = applyBranchAction(state, body);
    const canonicalMessages = syncCanonicalMessages(nextState);

    const savedConversation = await updateConversation(user.login, id, canonicalMessages, {
      ...extensionStateFromRecord(conversation),
      branches: nextState,
    });

    if (!savedConversation) {
      return errorResponse("Conversation not found.", 404);
    }

    return NextResponse.json({
      conversation: savedConversation,
      branches: branchSummaries(nextState),
      activeBranchId: nextState.activeBranchId,
      checkpoint: nextState.checkpoint,
    });
  } catch (error) {
    if (error instanceof BranchingError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof AuthConfigError || error instanceof ConversationStoreError) {
      return errorResponse(error.message, error.status);
    }

    return errorResponse("Branch action failed.", 500);
  }
}

function applyBranchAction(state: BranchingState, body: Record<string, unknown>): BranchingState {
  const action = body.action;

  switch (action) {
    case "set_checkpoint":
      return setCheckpoint(state, readNumber(body.index) ?? activeMessageCount(state), readString(body.label));
    case "fork":
      return forkBranch(state, {
        ...(readString(body.name) ? { name: readString(body.name) } : {}),
        ...(readNumber(body.atIndex) !== undefined ? { atIndex: readNumber(body.atIndex) } : {}),
      }).state;
    case "switch": {
      const branchId = readString(body.branchId);

      if (!branchId) {
        throw new BranchingError("branchId is required to switch branches.");
      }

      return switchBranch(state, branchId);
    }
    default:
      throw new BranchingError("action must be one of set_checkpoint, fork, switch.");
  }
}

function activeMessageCount(state: BranchingState) {
  return state.list.find((branch) => branch.id === state.activeBranchId)?.messages.length ?? 0;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
