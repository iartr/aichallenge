import { requireAuthenticatedUser } from "@/lib/auth";
import { getInterviewBundle } from "@/lib/interview-store";
import { AppStoreError } from "@/lib/db";
import { errorToResponse } from "@/lib/validation";

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
    const interview = await getInterviewBundle(user.login, id);

    if (!interview) {
      throw new AppStoreError("Interview not found.", 404);
    }

    return Response.json({ interview });
  } catch (error) {
    return errorToResponse(error);
  }
}
