import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getSql } from "./db";

export const ADMIN_LOGIN = "admin";
export const SEEDED_LOGINS = [ADMIN_LOGIN, "admin2", "admin3"] as const;
export const SESSION_COOKIE_NAME = "aichallenge_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const PASSWORD_ALGORITHM = "scrypt-sha256";
export const PASSWORD_KEY_LENGTH = 64;

export type AuthUser = {
  login: string;
};

export type StoredPasswordHash = {
  algorithm: string;
  salt: string;
  hash: string;
  keyLength: number;
};

export type PasswordHash = StoredPasswordHash & {
  algorithm: typeof PASSWORD_ALGORITHM;
};

type SessionPayload = {
  login: string;
  exp: number;
};

type AppUserRow = {
  login: string;
  password_algorithm: string;
  password_salt: string;
  password_hash: string;
  password_key_length: number | string;
};

const scryptAsync = promisify(scrypt);

declare global {
  var interviewCoachAuthMigration: Promise<void> | undefined;
}

export class AuthConfigError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AuthConfigError";
    this.status = status;
  }
}

export async function validateUserCredentials(login: unknown, password: unknown): Promise<AuthUser | null> {
  const normalizedLogin = readLogin(login);

  if (!normalizedLogin || typeof password !== "string" || !password) {
    return null;
  }

  await ensureAuthSchema();

  const [row] = await getSql()<AppUserRow[]>`
    select login, password_algorithm, password_salt, password_hash, password_key_length
    from app_users
    where login = ${normalizedLogin}
    limit 1
  `;

  if (!row) {
    return null;
  }

  const isValid = await verifyPassword(password, {
    algorithm: row.password_algorithm,
    salt: row.password_salt,
    hash: row.password_hash,
    keyLength: Number(row.password_key_length),
  });

  return isValid ? { login: row.login } : null;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("base64url")): Promise<PasswordHash> {
  const derivedKey = (await scryptAsync(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;

  return {
    algorithm: PASSWORD_ALGORITHM,
    salt,
    hash: derivedKey.toString("base64url"),
    keyLength: PASSWORD_KEY_LENGTH,
  };
}

export async function verifyPassword(password: string, stored: StoredPasswordHash): Promise<boolean> {
  if (
    stored.algorithm !== PASSWORD_ALGORITHM ||
    !stored.salt ||
    !stored.hash ||
    !Number.isInteger(stored.keyLength) ||
    stored.keyLength <= 0
  ) {
    return false;
  }

  const derivedKey = (await scryptAsync(password, stored.salt, stored.keyLength)) as Buffer;
  const storedKey = Buffer.from(stored.hash, "base64url");

  return derivedKey.length === storedKey.length && timingSafeEqual(derivedKey, storedKey);
}

export async function ensureAuthSchema() {
  if (!globalThis.interviewCoachAuthMigration) {
    globalThis.interviewCoachAuthMigration = getSql()`
      create table if not exists app_users (
        login text primary key,
        password_algorithm text not null,
        password_salt text not null,
        password_hash text not null,
        password_key_length integer not null default 64,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.then(() => undefined);
  }

  await globalThis.interviewCoachAuthMigration;
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

  if (!payload) {
    return null;
  }

  return {
    login: payload.login,
  };
}

export function requireAuthenticatedUser(request: Request, secret = process.env.SECRET): AuthUser {
  const user = getAuthenticatedUser(request, secret);

  if (!user) {
    throw new AuthConfigError("Unauthorized.", 401);
  }

  return user;
}

export function buildSessionSetCookie(login: string, secret = process.env.SECRET) {
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

    const login = readLogin(payload.login);

    if (!login) {
      return null;
    }

    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
      return null;
    }

    return {
      login,
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

function readLogin(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 80) : "";
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
