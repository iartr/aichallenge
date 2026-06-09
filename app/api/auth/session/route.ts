import { NextResponse } from "next/server";
import { AuthConfigError, getAuthenticatedUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return NextResponse.json({
      user: getAuthenticatedUser(request),
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return NextResponse.json(
        {
          error: {
            message: error.message,
          },
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        error: {
          message: "Session check failed.",
        },
      },
      { status: 500 },
    );
  }
}
