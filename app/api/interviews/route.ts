import { requireAuthenticatedUser } from "@/lib/auth";
import { createInterview, listInterviews } from "@/lib/interview-store";
import { errorToResponse, readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const interviews = await listInterviews(user.login);

    return Response.json({ interviews });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = requireAuthenticatedUser(request);
    const body = await readJsonBody(request);
    const interview = await createInterview(user.login, body);

    return Response.json({ interview });
  } catch (error) {
    return errorToResponse(error);
  }
}
