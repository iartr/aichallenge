import { NextResponse } from "next/server";
import { AuthConfigError, buildSessionSetCookie, validateUserCredentials } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  if (!isRecord(body)) {
    return errorResponse("Invalid login or password.", 401);
  }

  try {
    const user = await validateUserCredentials(body.login, body.password);

    if (!user) {
      return errorResponse("Invalid login or password.", 401);
    }

    return NextResponse.json(
      {
        user,
      },
      {
        headers: {
          "Set-Cookie": buildSessionSetCookie(user.login),
        },
      },
    );
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown) {
  if (error instanceof AuthConfigError) {
    return errorResponse(error.message, error.status);
  }

  if (error instanceof Error && "status" in error) {
    const status = Number((error as { status?: unknown }).status);

    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return errorResponse(error.message, status);
    }
  }

  return errorResponse("Login failed.", 500);
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
