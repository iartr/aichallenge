import { requireAuthenticatedUser } from "@/lib/auth";
import { getInterviewBundle } from "@/lib/interview-store";
import { resumePipeline, shouldResume } from "@/lib/interview-pipeline";
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

    // Self-heal: if the interview is mid-pipeline but no worker is driving it
    // (e.g. the process restarted), re-spawn the detached run. Guarded so the
    // 3s client polling can't pile up duplicate loops.
    if (shouldResume(interview)) {
      resumePipeline(user.login, id);
    }

    return Response.json({ interview });
  } catch (error) {
    return errorToResponse(error);
  }
}
