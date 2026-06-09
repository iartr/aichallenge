import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_LOGIN = "admin";
export const SESSION_COOKIE_NAME = "aichallenge_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type AuthUser = {
  login: typeof ADMIN_LOGIN;
};

type SessionPayload = {
  login: string;
  exp: number;
};

export class AuthConfigError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AuthConfigError";
    this.status = status;
  }
}

export function validateAdminCredentials(login: unknown, password: unknown, expectedPassword?: string): login is typeof ADMIN_LOGIN {
  if (login !== ADMIN_LOGIN || typeof password !== "string" || !expectedPassword) {
    return false;
  }

  return safeEqual(password, expectedPassword);
}

export function getAuthenticatedUser(request: Request, secret = process.env.SECRET): AuthUser | null {
  if (!secret) {
    throw new AuthConfigError("SECRET is not configured.");
  }

  const token = parseCookieHeader(request.headers.get("cookie"))[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const payload = readSessionToken(token, secret);

  if (!payload || payload.login !== ADMIN_LOGIN) {
    return null;
  }

  return {
    login: ADMIN_LOGIN,
  };
}

export function requireAuthenticatedUser(request: Request, secret = process.env.SECRET): AuthUser {
  const user = getAuthenticatedUser(request, secret);

  if (!user) {
    throw new AuthConfigError("Unauthorized.", 401);
  }

  return user;
}

export function buildSessionSetCookie(login: typeof ADMIN_LOGIN, secret = process.env.SECRET) {
  if (!secret) {
    throw new AuthConfigError("SECRET is not configured.");
  }

  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = createSessionToken({ login, exp: expiresAt }, secret);

  return serializeCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function buildLogoutSetCookie() {
  return serializeCookie(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function createSessionToken(payload: SessionPayload, secret: string) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function readSessionToken(token: string, secret: string): SessionPayload | null {
  const [encodedPayload, signature, extra] = token.split(".");

  if (!encodedPayload || !signature || extra !== undefined) {
    return null;
  }

  if (!safeEqual(signature, sign(encodedPayload, secret))) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as unknown;

    if (!isRecord(payload) || typeof payload.login !== "string" || typeof payload.exp !== "number") {
      return null;
    }

    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
      return null;
    }

    return {
      login: payload.login,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(header: string | null) {
  const cookies: Record<string, string> = {};

  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    const rawValue = rawValueParts.join("=");

    if (!rawName) {
      continue;
    }

    cookies[rawName] = decodeURIComponent(rawValue);
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    maxAge: number;
    path: string;
    sameSite: "Lax";
    secure: boolean;
  },
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
