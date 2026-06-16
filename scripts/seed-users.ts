import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ADMIN_LOGIN, SEEDED_LOGINS, ensureAuthSchema, hashPassword, type PasswordHash } from "../lib/auth";
import { getSql, isRecord } from "../lib/db";

type ExistingUserRow = {
  login: string;
};

type CredentialFile = {
  updatedAt: string;
  users: Record<string, StoredCredential>;
};

type StoredCredential = {
  login: string;
  password: string;
  createdAt: string;
};

const credentialsPath = resolve(process.cwd(), ".local-secrets/auth-users.json");

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD is not configured.");
  }

  await ensureAuthSchema();

  await upsertUser(ADMIN_LOGIN, await hashPassword(adminPassword));

  const credentials = readCredentialsFile(credentialsPath);

  for (const login of SEEDED_LOGINS) {
    if (login === ADMIN_LOGIN) {
      continue;
    }

    if (await userExists(login)) {
      continue;
    }

    const password = randomBytes(18).toString("base64url");
    await insertUser(login, await hashPassword(password));
    credentials.users[login] = {
      login,
      password,
      createdAt: new Date().toISOString(),
    };
  }

  writeCredentialsFile(credentialsPath, credentials);
  await getSql().end({ timeout: 5 });

  console.log(`Seeded users: ${SEEDED_LOGINS.join(", ")}`);
  console.log(`Generated passwords file: ${credentialsPath}`);
}

async function userExists(login: string) {
  const [row] = await getSql()<ExistingUserRow[]>`
    select login
    from app_users
    where login = ${login}
    limit 1
  `;

  return Boolean(row);
}

async function insertUser(login: string, passwordHash: PasswordHash) {
  await getSql()`
    insert into app_users (login, password_algorithm, password_salt, password_hash, password_key_length)
    values (${login}, ${passwordHash.algorithm}, ${passwordHash.salt}, ${passwordHash.hash}, ${passwordHash.keyLength})
  `;
}

async function upsertUser(login: string, passwordHash: PasswordHash) {
  await getSql()`
    insert into app_users (login, password_algorithm, password_salt, password_hash, password_key_length)
    values (${login}, ${passwordHash.algorithm}, ${passwordHash.salt}, ${passwordHash.hash}, ${passwordHash.keyLength})
    on conflict (login) do update
    set
      password_algorithm = excluded.password_algorithm,
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash,
      password_key_length = excluded.password_key_length,
      updated_at = now()
  `;
}

function readCredentialsFile(path: string): CredentialFile {
  if (!existsSync(path)) {
    return {
      updatedAt: new Date().toISOString(),
      users: {},
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

    if (!isRecord(parsed) || !isRecord(parsed.users)) {
      return {
        updatedAt: new Date().toISOString(),
        users: {},
      };
    }

    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      users: normalizeStoredCredentials(parsed.users),
    };
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      users: {},
    };
  }
}

function normalizeStoredCredentials(value: Record<string, unknown>) {
  const users: Record<string, StoredCredential> = {};

  for (const [login, credential] of Object.entries(value)) {
    if (!isRecord(credential) || typeof credential.password !== "string") {
      continue;
    }

    users[login] = {
      login,
      password: credential.password,
      createdAt: typeof credential.createdAt === "string" ? credential.createdAt : new Date().toISOString(),
    };
  }

  return users;
}

function writeCredentialsFile(path: string, credentials: CredentialFile) {
  const nextCredentials: CredentialFile = {
    updatedAt: new Date().toISOString(),
    users: credentials.users,
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(nextCredentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

main().catch(async (error: unknown) => {
  try {
    await getSql().end({ timeout: 5 });
  } catch {
    // Ignore shutdown errors while surfacing the original seed failure.
  }

  console.error(error instanceof Error ? error.message : "User seed failed.");
  process.exitCode = 1;
});
