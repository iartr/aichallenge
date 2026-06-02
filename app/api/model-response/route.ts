import { NextResponse } from "next/server";
import { handleProviderResponseRequest } from "@/lib/provider-response";

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

  const result = await handleProviderResponseRequest(
    body && typeof body === "object" ? body : {},
    {
      SECRET: process.env.SECRET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  );

  return NextResponse.json(result.body, { status: result.status });
}
