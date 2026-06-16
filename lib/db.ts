import postgres from "postgres";

export type SqlClient = ReturnType<typeof postgres>;
export type JsonRecord = Record<string, unknown>;

const DEFAULT_SSL = "require";

export class AppStoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "AppStoreError";
    this.status = status;
  }
}

declare global {
  var interviewCoachSql: SqlClient | undefined;
  var interviewCoachMigration: Promise<void> | undefined;
}

export function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new AppStoreError("DATABASE_URL is not configured.");
  }

  if (!globalThis.interviewCoachSql) {
    const databaseUrl = process.env.DATABASE_URL;

    globalThis.interviewCoachSql = postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 20,
      max: 5,
      ssl: shouldUseSsl(databaseUrl) ? DEFAULT_SSL : false,
    });
  }

  return globalThis.interviewCoachSql;
}

export async function ensureAppSchema() {
  if (!globalThis.interviewCoachMigration) {
    globalThis.interviewCoachMigration = runMigrations();
  }

  await globalThis.interviewCoachMigration;
}

async function runMigrations() {
  const sql = getSql();

  await sql`create extension if not exists vector`;

  await sql`
    create table if not exists admin_settings (
      id boolean primary key default true,
      llm_provider text not null default 'openai',
      llm_model text not null default 'gpt-4.1-mini',
      stt_provider text not null default 'assemblyai',
      stt_model text not null default 'best',
      system_prompt text not null default '',
      user_prompt_template text not null default '',
      assistant_prompt_template text not null default '',
      prompt_variables jsonb not null default '{}'::jsonb,
      provider_metadata jsonb not null default '{}'::jsonb,
      rag_enabled boolean not null default false,
      rag_config jsonb not null default '{}'::jsonb,
      mcp_enabled boolean not null default false,
      mcp_servers jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint admin_settings_singleton check (id)
    )
  `;

  await sql`insert into admin_settings (id) values (true) on conflict (id) do nothing`;

  await sql`
    create table if not exists interviews (
      id uuid primary key,
      user_login text not null,
      company text not null default '',
      position text not null default '',
      target_level text not null default '',
      interview_type text not null default '',
      status text not null default 'draft',
      source_type text not null default 'upload',
      source_url text not null default '',
      task_memory jsonb not null default '{}'::jsonb,
      llm_output jsonb not null default '{}'::jsonb,
      provider_metadata jsonb not null default '{}'::jsonb,
      transcript text not null default '',
      transcript_metadata jsonb not null default '{}'::jsonb,
      error_message text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists interviews_user_login_updated_at_idx
    on interviews (user_login, updated_at desc)
  `;

  await sql`
    create table if not exists interview_assets (
      id uuid primary key,
      interview_id uuid not null references interviews(id) on delete cascade,
      kind text not null,
      source_type text not null,
      original_name text not null default '',
      content_type text not null default '',
      size_bytes bigint not null default 0,
      s3_key text not null default '',
      external_url text not null default '',
      upload_status text not null default 'pending',
      provider_metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`create index if not exists interview_assets_interview_id_idx on interview_assets (interview_id)`;

  await sql`
    create table if not exists conversation_messages (
      id uuid primary key,
      interview_id uuid not null references interviews(id) on delete cascade,
      user_login text not null,
      role text not null,
      content text not null,
      memory_layer text not null default 'working',
      provider_metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists conversation_messages_interview_created_idx
    on conversation_messages (interview_id, created_at asc)
  `;

  await sql`
    create table if not exists conversation_summaries (
      interview_id uuid primary key references interviews(id) on delete cascade,
      user_login text not null,
      summary text not null default '',
      covered_message_count integer not null default 0,
      provider_metadata jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists profile_memory (
      id uuid primary key,
      user_login text not null,
      statement text not null,
      tags jsonb not null default '[]'::jsonb,
      payload jsonb not null default '{}'::jsonb,
      source text not null default 'explicit',
      embedding vector(1536),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists profile_memory_user_updated_idx
    on profile_memory (user_login, updated_at desc)
  `;

  await sql`
    create table if not exists knowledge_memory (
      id uuid primary key,
      title text not null,
      content text not null,
      tags jsonb not null default '[]'::jsonb,
      payload jsonb not null default '{}'::jsonb,
      embedding vector(1536),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`create index if not exists knowledge_memory_updated_idx on knowledge_memory (updated_at desc)`;

  await sql`
    create table if not exists llm_runs (
      id uuid primary key,
      interview_id uuid references interviews(id) on delete set null,
      user_login text not null,
      run_type text not null,
      provider text not null,
      model text not null,
      prompt_variables jsonb not null default '{}'::jsonb,
      input_messages jsonb not null default '[]'::jsonb,
      output jsonb not null default '{}'::jsonb,
      provider_metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists memory_audit_events (
      id uuid primary key,
      user_login text not null,
      interview_id uuid references interviews(id) on delete set null,
      layer text not null,
      action text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
    create index if not exists memory_audit_user_created_idx
    on memory_audit_events (user_login, created_at desc)
  `;

  await createVectorIndexesBestEffort(sql);
}

async function createVectorIndexesBestEffort(sql: SqlClient) {
  try {
    await sql`create index if not exists profile_memory_embedding_hnsw_idx on profile_memory using hnsw (embedding vector_cosine_ops)`;
    await sql`create index if not exists knowledge_memory_embedding_hnsw_idx on knowledge_memory using hnsw (embedding vector_cosine_ops)`;
  } catch {
    // Older pgvector builds may not have HNSW. Exact search still works through vector distance operators.
  }
}

export function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function shouldUseSsl(databaseUrl: string) {
  if (process.env.DATABASE_SSL === "false") {
    return false;
  }

  return !/\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/.test(databaseUrl);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeJsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function normalizeJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
