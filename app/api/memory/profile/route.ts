import { requireAuthenticatedUser } from "@/lib/auth";
import { createProfileMemory, listProfileMemory } from "@/lib/memory-store";
import { errorToResponse, readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const items = await listProfileMemory(user.login);

    return Response.json({ items });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const body = await readJsonBody(request);
    const item = await createProfileMemory({
      userLogin: user.login,
      statement: body.statement,
      tags: body.tags,
      payload: body.payload,
      source: body.source,
      confirm: body.confirm,
      interviewId: typeof body.interviewId === "string" ? body.interviewId : null,
    });

    return Response.json({ item });
  } catch (error) {
    return errorToResponse(error);
  }
}
