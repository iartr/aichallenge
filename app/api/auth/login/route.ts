import { NextResponse } from "next/server";
import { ADMIN_LOGIN, AuthConfigError, buildSessionSetCookie, validateAdminCredentials } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  if (!process.env.ADMIN_PASSWORD) {
    return errorResponse("ADMIN_PASSWORD is not configured.", 500);
  }

  if (!isRecord(body) || !validateAdminCredentials(body.login, body.password, process.env.ADMIN_PASSWORD)) {
    return errorResponse("Invalid login or password.", 401);
  }

  try {
    return NextResponse.json(
      {
        user: {
          login: ADMIN_LOGIN,
        },
      },
      {
        headers: {
          "Set-Cookie": buildSessionSetCookie(ADMIN_LOGIN),
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
