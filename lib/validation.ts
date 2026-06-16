import { AppStoreError, isRecord } from "./db";

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;

    if (!isRecord(body)) {
      throw new AppStoreError("Request body must be a JSON object.", 400);
    }

    return body;
  } catch (error) {
    if (error instanceof AppStoreError) {
      throw error;
    }

    throw new AppStoreError("Request body must be valid JSON.", 400);
  }
}

export function readRequiredString(body: Record<string, unknown>, field: string, maxLength = 12000) {
  const value = body[field];

  if (typeof value !== "string" || !value.trim()) {
    throw new AppStoreError(`${field} is required.`, 400);
  }

  return value.trim().slice(0, maxLength);
}

export function readOptionalString(body: Record<string, unknown>, field: string, maxLength = 12000) {
  const value = body[field];

  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function readBoolean(body: Record<string, unknown>, field: string, fallback = false) {
  const value = body[field];

  return typeof value === "boolean" ? value : fallback;
}

export function parseJsonText(value: string, fallback: unknown) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

export function errorToResponse(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected error.";

  return Response.json(
    {
      error: {
        message,
      },
    },
    { status },
  );
}
