import { requireAuthenticatedUser } from "@/lib/auth";
import { getAdminSettings, updateAdminSettings } from "@/lib/admin-settings";
import { errorToResponse, readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireAuthenticatedUser(request);
    const settings = await getAdminSettings();

    return Response.json({ settings });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireAuthenticatedUser(request);
    const body = await readJsonBody(request);
    const settings = await updateAdminSettings(body);

    return Response.json({ settings });
  } catch (error) {
    return errorToResponse(error);
  }
}
