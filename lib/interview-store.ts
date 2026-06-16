import { randomUUID } from "node:crypto";
import { AppStoreError, ensureAppSchema, getSql, isRecord, normalizeJsonRecord, sqlJson, toIsoString } from "./db";

export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SCREENSHOTS = 10;

export type InterviewStatus = "draft" | "uploaded" | "transcribing" | "transcribed" | "analyzing" | "analyzed" | "error";
export type AssetKind = "recording" | "screenshot";
export type AssetSourceType = "s3" | "url";

export type InterviewRecord = {
  id: string;
  userLogin: string;
  company: string;
  position: string;
  targetLevel: string;
  interviewType: string;
  status: InterviewStatus;
  sourceType: string;
  sourceUrl: string;
  taskMemory: Record<string, unknown>;
  llmOutput: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
  transcript: string;
  transcriptMetadata: Record<string, unknown>;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type InterviewAsset = {
  id: string;
  interviewId: string;
  kind: AssetKind;
  sourceType: AssetSourceType;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  s3Key: string;
  externalUrl: string;
  uploadStatus: string;
  providerMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  id: string;
  interviewId: string;
  role: "user" | "assistant";
  content: string;
  memoryLayer: "working";
  providerMetadata: Record<string, unknown>;
  createdAt: string;
};

export type InterviewBundle = InterviewRecord & {
  assets: InterviewAsset[];
  messages: ConversationMessage[];
};

export type CreateInterviewInput = {
  company?: unknown;
  position?: unknown;
  targetLevel?: unknown;
  interviewType?: unknown;
  sourceType?: unknown;
  sourceUrl?: unknown;
};

export type AssetInput = {
  kind: AssetKind;
  sourceType: AssetSourceType;
  originalName?: string;
  contentType?: string;
  sizeBytes?: number;
  s3Key?: string;
  externalUrl?: string;
  uploadStatus?: string;
  providerMetadata?: Record<string, unknown>;
};

type InterviewRow = {
  id: string;
  user_login: string;
  company: string;
  position: string;
  target_level: string;
  interview_type: string;
  status: string;
  source_type: string;
  source_url: string;
  task_memory: unknown;
  llm_output: unknown;
  provider_metadata: unknown;
  transcript: string;
  transcript_metadata: unknown;
  error_message: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type AssetRow = {
  id: string;
  interview_id: string;
  kind: string;
  source_type: string;
  original_name: string;
  content_type: string;
  size_bytes: number | string;
  s3_key: string;
  external_url: string;
  upload_status: string;
  provider_metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  interview_id: string;
  role: string;
  content: string;
  memory_layer: string;
  provider_metadata: unknown;
  created_at: Date | string;
};

export async function listInterviews(userLogin: string): Promise<InterviewRecord[]> {
  await ensureAppSchema();

  const rows = await getSql()<InterviewRow[]>`
    select * from interviews
    where user_login = ${userLogin}
    order by updated_at desc
  `;

  return rows.map(rowToInterview);
}

export async function createInterview(userLogin: string, input: CreateInterviewInput): Promise<InterviewRecord> {
  await ensureAppSchema();

  const id = randomUUID();
  const company = readText(input.company);
  const position = readText(input.position);
  const targetLevel = readText(input.targetLevel);
  const interviewType = readText(input.interviewType);
  const sourceType = readText(input.sourceType) || "upload";
  const sourceUrl = readText(input.sourceUrl);
  const taskMemory = {
    company,
    position,
    targetLevel,
    interviewType,
    sourceType,
    sourceUrl,
  };

  const [row] = await getSql()<InterviewRow[]>`
    insert into interviews (
      id,
      user_login,
      company,
      position,
      target_level,
      interview_type,
      source_type,
      source_url,
      task_memory
    ) values (
      ${id},
      ${userLogin},
      ${company},
      ${position},
      ${targetLevel},
      ${interviewType},
      ${sourceType},
      ${sourceUrl},
      ${sqlJson(taskMemory)}
    )
    returning *
  `;

  if (!row) {
    throw new AppStoreError("Interview was not created.");
  }

  await recordAudit(userLogin, id, "task", "task_memory_initialized", taskMemory);

  return rowToInterview(row);
}

export async function getInterviewBundle(userLogin: string, id: string): Promise<InterviewBundle | null> {
  await ensureAppSchema();

  const interview = await getInterview(userLogin, id);

  if (!interview) {
    return null;
  }

  const [assets, messages] = await Promise.all([listAssets(id), listConversationMessages(userLogin, id)]);

  return {
    ...interview,
    assets,
    messages,
  };
}

export async function getInterview(userLogin: string, id: string): Promise<InterviewRecord | null> {
  await ensureAppSchema();

  const [row] = await getSql()<InterviewRow[]>`
    select * from interviews
    where user_login = ${userLogin} and id = ${id}
    limit 1
  `;

  return row ? rowToInterview(row) : null;
}

export async function listAssets(interviewId: string): Promise<InterviewAsset[]> {
  await ensureAppSchema();

  const rows = await getSql()<AssetRow[]>`
    select * from interview_assets
    where interview_id = ${interviewId}
    order by created_at asc
  `;

  return rows.map(rowToAsset);
}

export async function createAsset(interviewId: string, input: AssetInput): Promise<InterviewAsset> {
  await ensureAppSchema();

  if (input.kind === "recording" && Number(input.sizeBytes ?? 0) > MAX_RECORDING_BYTES) {
    throw new AppStoreError("Recording is larger than 2 GB.", 400);
  }

  if (input.kind === "screenshot") {
    const screenshotCount = (await listAssets(interviewId)).filter((asset) => asset.kind === "screenshot").length;

    if (screenshotCount >= MAX_SCREENSHOTS) {
      throw new AppStoreError("You can attach up to 10 screenshots.", 400);
    }
  }

  const id = randomUUID();
  const [row] = await getSql()<AssetRow[]>`
    insert into interview_assets (
      id,
      interview_id,
      kind,
      source_type,
      original_name,
      content_type,
      size_bytes,
      s3_key,
      external_url,
      upload_status,
      provider_metadata
    ) values (
      ${id},
      ${interviewId},
      ${input.kind},
      ${input.sourceType},
      ${input.originalName ?? ""},
      ${input.contentType ?? ""},
      ${input.sizeBytes ?? 0},
      ${input.s3Key ?? ""},
      ${input.externalUrl ?? ""},
      ${input.uploadStatus ?? "pending"},
      ${sqlJson(input.providerMetadata ?? {})}
    )
    returning *
  `;

  if (!row) {
    throw new AppStoreError("Asset was not created.");
  }

  return rowToAsset(row);
}

export async function markAssetUploaded(userLogin: string, interviewId: string, assetId: string): Promise<InterviewAsset | null> {
  await ensureAppSchema();
  await assertInterviewAccess(userLogin, interviewId);

  const [row] = await getSql()<AssetRow[]>`
    update interview_assets
    set upload_status = 'uploaded', updated_at = now()
    where id = ${assetId} and interview_id = ${interviewId}
    returning *
  `;

  return row ? rowToAsset(row) : null;
}

export async function updateInterviewPatch(
  userLogin: string,
  id: string,
  patch: Partial<{
    status: InterviewStatus;
    taskMemory: Record<string, unknown>;
    llmOutput: Record<string, unknown>;
    providerMetadata: Record<string, unknown>;
    transcript: string;
    transcriptMetadata: Record<string, unknown>;
    errorMessage: string;
  }>,
): Promise<InterviewRecord | null> {
  await ensureAppSchema();
  const current = await getInterview(userLogin, id);

  if (!current) {
    return null;
  }

  const next = {
    status: patch.status ?? current.status,
    taskMemory: patch.taskMemory ?? current.taskMemory,
    llmOutput: patch.llmOutput ?? current.llmOutput,
    providerMetadata: patch.providerMetadata ?? current.providerMetadata,
    transcript: patch.transcript ?? current.transcript,
    transcriptMetadata: patch.transcriptMetadata ?? current.transcriptMetadata,
    errorMessage: patch.errorMessage ?? current.errorMessage,
  };

  const [row] = await getSql()<InterviewRow[]>`
    update interviews
    set
      status = ${next.status},
      task_memory = ${sqlJson(next.taskMemory)},
      llm_output = ${sqlJson(next.llmOutput)},
      provider_metadata = ${sqlJson(next.providerMetadata)},
      transcript = ${next.transcript},
      transcript_metadata = ${sqlJson(next.transcriptMetadata)},
      error_message = ${next.errorMessage},
      updated_at = now()
    where user_login = ${userLogin} and id = ${id}
    returning *
  `;

  return row ? rowToInterview(row) : null;
}

export async function appendConversationMessage(
  userLogin: string,
  interviewId: string,
  role: "user" | "assistant",
  content: string,
  providerMetadata: Record<string, unknown> = {},
): Promise<ConversationMessage> {
  await ensureAppSchema();
  await assertInterviewAccess(userLogin, interviewId);

  const id = randomUUID();
  const [row] = await getSql()<MessageRow[]>`
    insert into conversation_messages (id, interview_id, user_login, role, content, memory_layer, provider_metadata)
    values (${id}, ${interviewId}, ${userLogin}, ${role}, ${content}, 'working', ${sqlJson(providerMetadata)})
    returning *
  `;

  if (!row) {
    throw new AppStoreError("Message was not saved.");
  }

  return rowToMessage(row);
}

export async function listConversationMessages(userLogin: string, interviewId: string, limit = 200): Promise<ConversationMessage[]> {
  await ensureAppSchema();
  await assertInterviewAccess(userLogin, interviewId);

  const rows = await getSql()<MessageRow[]>`
    select * from conversation_messages
    where user_login = ${userLogin} and interview_id = ${interviewId}
    order by created_at asc
    limit ${limit}
  `;

  return rows.map(rowToMessage);
}

export async function saveLlmRun(input: {
  userLogin: string;
  interviewId?: string | null;
  runType: string;
  provider: string;
  model: string;
  promptVariables: Record<string, unknown>;
  inputMessages: unknown[];
  output: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
}) {
  await ensureAppSchema();

  await getSql()`
    insert into llm_runs (
      id,
      interview_id,
      user_login,
      run_type,
      provider,
      model,
      prompt_variables,
      input_messages,
      output,
      provider_metadata
    ) values (
      ${randomUUID()},
      ${input.interviewId ?? null},
      ${input.userLogin},
      ${input.runType},
      ${input.provider},
      ${input.model},
      ${sqlJson(input.promptVariables)},
      ${sqlJson(input.inputMessages)},
      ${sqlJson(input.output)},
      ${sqlJson(input.providerMetadata)}
    )
  `;
}

export async function recordAudit(
  userLogin: string,
  interviewId: string | null,
  layer: string,
  action: string,
  payload: Record<string, unknown>,
) {
  await ensureAppSchema();

  await getSql()`
    insert into memory_audit_events (id, user_login, interview_id, layer, action, payload)
    values (${randomUUID()}, ${userLogin}, ${interviewId}, ${layer}, ${action}, ${sqlJson(payload)})
  `;
}

export async function findRecordingAsset(interviewId: string): Promise<InterviewAsset | null> {
  const assets = await listAssets(interviewId);

  return assets.find((asset) => asset.kind === "recording" && asset.uploadStatus !== "failed") ?? null;
}

async function assertInterviewAccess(userLogin: string, interviewId: string) {
  const interview = await getInterview(userLogin, interviewId);

  if (!interview) {
    throw new AppStoreError("Interview not found.", 404);
  }
}

function rowToInterview(row: InterviewRow): InterviewRecord {
  return {
    id: row.id,
    userLogin: row.user_login,
    company: row.company,
    position: row.position,
    targetLevel: row.target_level,
    interviewType: row.interview_type,
    status: normalizeStatus(row.status),
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    taskMemory: normalizeJsonRecord(row.task_memory),
    llmOutput: normalizeJsonRecord(row.llm_output),
    providerMetadata: normalizeJsonRecord(row.provider_metadata),
    transcript: row.transcript,
    transcriptMetadata: normalizeJsonRecord(row.transcript_metadata),
    errorMessage: row.error_message,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToAsset(row: AssetRow): InterviewAsset {
  return {
    id: row.id,
    interviewId: row.interview_id,
    kind: row.kind === "screenshot" ? "screenshot" : "recording",
    sourceType: row.source_type === "url" ? "url" : "s3",
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    s3Key: row.s3_key,
    externalUrl: row.external_url,
    uploadStatus: row.upload_status,
    providerMetadata: normalizeJsonRecord(row.provider_metadata),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    interviewId: row.interview_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    memoryLayer: "working",
    providerMetadata: normalizeJsonRecord(row.provider_metadata),
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeStatus(value: string): InterviewStatus {
  const statuses: InterviewStatus[] = ["draft", "uploaded", "transcribing", "transcribed", "analyzing", "analyzed", "error"];

  return statuses.includes(value as InterviewStatus) ? (value as InterviewStatus) : "draft";
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 4000) : "";
}

export function normalizeAnalysisOutput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { raw: value };
}
