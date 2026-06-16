import { randomUUID } from "node:crypto";
import { AppStoreError, ensureAppSchema, getSql, normalizeJsonArray, normalizeJsonRecord, sqlJson, toIsoString } from "./db";
import { recordAudit } from "./interview-store";

export type ProfileMemoryItem = {
  id: string;
  userLogin: string;
  statement: string;
  tags: unknown[];
  payload: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeMemoryItem = {
  id: string;
  title: string;
  content: string;
  tags: unknown[];
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ProfileMemoryRow = {
  id: string;
  user_login: string;
  statement: string;
  tags: unknown;
  payload: unknown;
  source: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type KnowledgeMemoryRow = {
  id: string;
  title: string;
  content: string;
  tags: unknown;
  payload: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function listProfileMemory(userLogin: string, limit = 50): Promise<ProfileMemoryItem[]> {
  await ensureAppSchema();

  const rows = await getSql()<ProfileMemoryRow[]>`
    select id, user_login, statement, tags, payload, source, created_at, updated_at
    from profile_memory
    where user_login = ${userLogin}
    order by updated_at desc
    limit ${limit}
  `;

  return rows.map(rowToProfileMemory);
}

export async function createProfileMemory(input: {
  userLogin: string;
  statement: unknown;
  tags?: unknown;
  payload?: unknown;
  source?: unknown;
  confirm?: unknown;
  interviewId?: string | null;
}): Promise<ProfileMemoryItem> {
  await ensureAppSchema();

  if (input.confirm !== true) {
    await recordAudit(input.userLogin, input.interviewId ?? null, "profile", "profile_memory_rejected_missing_confirmation", {
      statement: typeof input.statement === "string" ? input.statement : "",
    });
    throw new AppStoreError("Profile memory writes require confirm: true.", 400);
  }

  const statement = readRequiredText(input.statement, "statement");
  const id = randomUUID();
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const payload = normalizeJsonRecord(input.payload);
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : "explicit";

  const [row] = await getSql()<ProfileMemoryRow[]>`
    insert into profile_memory (id, user_login, statement, tags, payload, source)
    values (${id}, ${input.userLogin}, ${statement}, ${sqlJson(tags)}, ${sqlJson(payload)}, ${source})
    returning id, user_login, statement, tags, payload, source, created_at, updated_at
  `;

  if (!row) {
    throw new AppStoreError("Profile memory was not saved.");
  }

  await recordAudit(input.userLogin, input.interviewId ?? null, "profile", "profile_memory_written_explicitly", {
    id,
    statement,
    source,
  });

  return rowToProfileMemory(row);
}

export async function listKnowledgeMemory(limit = 50): Promise<KnowledgeMemoryItem[]> {
  await ensureAppSchema();

  const rows = await getSql()<KnowledgeMemoryRow[]>`
    select id, title, content, tags, payload, created_at, updated_at
    from knowledge_memory
    order by updated_at desc
    limit ${limit}
  `;

  return rows.map(rowToKnowledgeMemory);
}

export async function createKnowledgeMemory(input: {
  userLogin: string;
  title: unknown;
  content: unknown;
  tags?: unknown;
  payload?: unknown;
}): Promise<KnowledgeMemoryItem> {
  await ensureAppSchema();

  const title = readRequiredText(input.title, "title");
  const content = readRequiredText(input.content, "content");
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const payload = normalizeJsonRecord(input.payload);
  const id = randomUUID();

  const [row] = await getSql()<KnowledgeMemoryRow[]>`
    insert into knowledge_memory (id, title, content, tags, payload)
    values (${id}, ${title}, ${content}, ${sqlJson(tags)}, ${sqlJson(payload)})
    returning id, title, content, tags, payload, created_at, updated_at
  `;

  if (!row) {
    throw new AppStoreError("Knowledge memory was not saved.");
  }

  await recordAudit(input.userLogin, null, "knowledge", "knowledge_memory_written", {
    id,
    title,
  });

  return rowToKnowledgeMemory(row);
}

export function formatProfileMemoryForPrompt(items: ProfileMemoryItem[]) {
  if (items.length === 0) {
    return "Нет явно сохраненной profile memory.";
  }

  return items.map((item, index) => `${index + 1}. ${item.statement}`).join("\n");
}

export function formatKnowledgeMemoryForPrompt(items: KnowledgeMemoryItem[]) {
  if (items.length === 0) {
    return "Knowledge memory пока пустая.";
  }

  return items.map((item, index) => `${index + 1}. ${item.title}: ${item.content}`).join("\n");
}

function rowToProfileMemory(row: ProfileMemoryRow): ProfileMemoryItem {
  return {
    id: row.id,
    userLogin: row.user_login,
    statement: row.statement,
    tags: normalizeJsonArray(row.tags),
    payload: normalizeJsonRecord(row.payload),
    source: row.source,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToKnowledgeMemory(row: KnowledgeMemoryRow): KnowledgeMemoryItem {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: normalizeJsonArray(row.tags),
    payload: normalizeJsonRecord(row.payload),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function readRequiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppStoreError(`${field} is required.`, 400);
  }

  return value.trim().slice(0, 12000);
}
