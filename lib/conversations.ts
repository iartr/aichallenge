import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { AgentChatMessage } from "./chat-agent";
import { normalizeSummarizerUsage, type SummarizerUsageTotals } from "./history-compression";
import { normalizeMessageTokenUsage } from "./token-usage";

export type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationCompressionState = {
  summary: string;
  summaryCoveredCount: number;
  summarizerUsage: SummarizerUsageTotals;
};

export type ConversationRecord = ConversationSummary &
  ConversationCompressionState & {
    messages: AgentChatMessage[];
  };

type ConversationRow = {
  id: string;
  title: string;
  messages: unknown;
  message_count: number;
  summary: string | null;
  summary_covered_count: number | string | null;
  summarizer_usage: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type SqlClient = ReturnType<typeof postgres>;

declare global {
  var aichallengeSql: SqlClient | undefined;
}

let migrationPromise: Promise<void> | null = null;

export class ConversationStoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ConversationStoreError";
    this.status = status;
  }
}

export async function listConversations(userLogin: string): Promise<ConversationSummary[]> {
  await ensureConversationsTable();

  const rows = await getSql()<ConversationRow[]>`
    select
      id,
      title,
      messages,
      jsonb_array_length(messages) as message_count,
      created_at,
      updated_at
    from conversations
    where user_login = ${userLogin}
    order by updated_at desc
  `;

  return rows.map(rowToSummary);
}

export async function getConversation(userLogin: string, id: string): Promise<ConversationRecord | null> {
  await ensureConversationsTable();

  const [row] = await getSql()<ConversationRow[]>`
    select
      id,
      title,
      messages,
      jsonb_array_length(messages) as message_count,
      summary,
      summary_covered_count,
      summarizer_usage,
      created_at,
      updated_at
    from conversations
    where user_login = ${userLogin} and id = ${id}
    limit 1
  `;

  return row ? rowToConversation(row) : null;
}

export async function createConversation(
  userLogin: string,
  messages: AgentChatMessage[],
  title = buildConversationTitle(messages.find((message) => message.role === "user")?.content ?? "New chat"),
): Promise<ConversationRecord> {
  await ensureConversationsTable();

  const id = randomUUID();
  const normalizedMessages = normalizeStoredMessages(messages);
  const [row] = await getSql()<ConversationRow[]>`
    insert into conversations (id, user_login, title, messages)
    values (${id}, ${userLogin}, ${title}, ${getSql().json(normalizedMessages)})
    returning
      id,
      title,
      messages,
      jsonb_array_length(messages) as message_count,
      summary,
      summary_covered_count,
      summarizer_usage,
      created_at,
      updated_at
  `;

  if (!row) {
    throw new ConversationStoreError("Conversation was not created.");
  }

  return rowToConversation(row);
}

export async function updateConversation(
  userLogin: string,
  id: string,
  messages: AgentChatMessage[],
  compression?: ConversationCompressionState,
): Promise<ConversationRecord | null> {
  await ensureConversationsTable();

  const normalizedMessages = normalizeStoredMessages(messages);
  // The postgres tagged-template driver does not compose conditional set
  // clauses, so the compression branch is a separate full query.
  const [row] = compression
    ? await getSql()<ConversationRow[]>`
        update conversations
        set
          messages = ${getSql().json(normalizedMessages)},
          summary = ${compression.summary},
          summary_covered_count = ${compression.summaryCoveredCount},
          summarizer_usage = ${getSql().json(compression.summarizerUsage)},
          updated_at = now()
        where user_login = ${userLogin} and id = ${id}
        returning
          id,
          title,
          messages,
          jsonb_array_length(messages) as message_count,
          summary,
          summary_covered_count,
          summarizer_usage,
          created_at,
          updated_at
      `
    : await getSql()<ConversationRow[]>`
        update conversations
        set messages = ${getSql().json(normalizedMessages)}, updated_at = now()
        where user_login = ${userLogin} and id = ${id}
        returning
          id,
          title,
          messages,
          jsonb_array_length(messages) as message_count,
          summary,
          summary_covered_count,
          summarizer_usage,
          created_at,
          updated_at
      `;

  return row ? rowToConversation(row) : null;
}

export function buildConversationTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  const title = compact || "New chat";

  return title.length > 52 ? `${title.slice(0, 49)}...` : title;
}

export function normalizeStoredMessages(messages: unknown): AgentChatMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized: AgentChatMessage[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    const { role, content } = message;

    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      const usage = normalizeMessageTokenUsage(message.usage);
      const normalizedMessage: AgentChatMessage = {
        role,
        content: content.trim(),
      };

      if (usage) {
        normalizedMessage.usage = usage;
      }

      normalized.push(normalizedMessage);
    }
  }

  return normalized;
}

async function ensureConversationsTable() {
  if (!migrationPromise) {
    migrationPromise = getSql()`
      create table if not exists conversations (
        id text primary key,
        user_login text not null,
        title text not null,
        messages jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.then(async () => {
      await getSql()`
        create index if not exists conversations_user_login_updated_at_idx
        on conversations (user_login, updated_at desc)
      `;
      await getSql()`
        alter table conversations
        add column if not exists summary text not null default ''
      `;
      await getSql()`
        alter table conversations
        add column if not exists summary_covered_count integer not null default 0
      `;
      await getSql()`
        alter table conversations
        add column if not exists summarizer_usage jsonb not null default '{}'::jsonb
      `;
    });
  }

  await migrationPromise;
}

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new ConversationStoreError("DATABASE_URL is not configured.");
  }

  if (!globalThis.aichallengeSql) {
    const databaseUrl = process.env.DATABASE_URL;

    globalThis.aichallengeSql = postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 20,
      max: 5,
      ssl: shouldUseSsl(databaseUrl) ? "require" : false,
    });
  }

  return globalThis.aichallengeSql;
}

function shouldUseSsl(databaseUrl: string) {
  if (process.env.DATABASE_SSL === "false") {
    return false;
  }

  return !/\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/.test(databaseUrl);
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  const messages = normalizeStoredMessages(row.messages);
  const summary = typeof row.summary === "string" ? row.summary : "";
  const coveredCount = Math.floor(Number(row.summary_covered_count ?? 0));

  return {
    ...rowToSummary(row),
    messages,
    summary,
    summaryCoveredCount: Math.min(Math.max(Number.isFinite(coveredCount) ? coveredCount : 0, 0), messages.length),
    summarizerUsage: normalizeSummarizerUsage(row.summarizer_usage),
  };
}

function rowToSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    messageCount: Number(row.message_count),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
