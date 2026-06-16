import { requireAuthenticatedUser } from "@/lib/auth";
import { createKnowledgeMemory, listKnowledgeMemory } from "@/lib/memory-store";
import { errorToResponse, readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireAuthenticatedUser(request);
    const items = await listKnowledgeMemory();

    return Response.json({ items });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const body = await readJsonBody(request);
    const item = await createKnowledgeMemory({
      userLogin: user.login,
      title: body.title,
      content: body.content,
      tags: body.tags,
      payload: body.payload,
    });

    return Response.json({ item });
  } catch (error) {
    return errorToResponse(error);
  }
}
