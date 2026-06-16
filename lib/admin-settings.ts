import { randomUUID } from "node:crypto";
import { AppStoreError, ensureAppSchema, getSql, normalizeJsonArray, normalizeJsonRecord, toIsoString } from "./db";

export type LlmProvider = "openai" | "anthropic";

export type AdminSettings = {
  llmProvider: LlmProvider;
  llmModel: string;
  sttProvider: "assemblyai";
  sttModel: string;
  systemPrompt: string;
  userPromptTemplate: string;
  assistantPromptTemplate: string;
  promptVariables: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
  ragEnabled: boolean;
  ragConfig: Record<string, unknown>;
  mcpEnabled: boolean;
  mcpServers: unknown[];
  updatedAt: string;
};

export type AdminSettingsInput = Partial<Omit<AdminSettings, "updatedAt">>;

type SettingsRow = {
  llm_provider: string;
  llm_model: string;
  stt_provider: string;
  stt_model: string;
  system_prompt: string;
  user_prompt_template: string;
  assistant_prompt_template: string;
  prompt_variables: unknown;
  provider_metadata: unknown;
  rag_enabled: boolean;
  rag_config: unknown;
  mcp_enabled: boolean;
  mcp_servers: unknown;
  updated_at: Date | string;
};

export const DEFAULT_SYSTEM_PROMPT = `Ты ассистент для разбора IT-собеседований. Строго разделяй memory layers: working memory — текущий чат; task memory — только данные конкретного интервью; profile memory — долгосрочные факты о пользователе, которые нельзя сохранять без явного подтверждения; knowledge memory — обобщенные знания продукта. Не смешивай task memory и profile memory. Новые долгосрочные наблюдения возвращай только как candidateProfileMemory.`;

export const DEFAULT_USER_PROMPT_TEMPLATE = `Проанализируй интервью и верни валидный JSON без markdown.

Контекст интервью:
{{interviewContext}}

Ассеты:
{{assetsContext}}

Транскрипт:
{{transcript}}

Profile memory, сохраненная явно:
{{profileMemory}}

Knowledge memory продукта:
{{knowledgeMemory}}

Схема: {"score":number,"summary":string,"timeline":array,"mistakes":array,"strengths":array,"weaknesses":array,"taskMemory":object,"candidateProfileMemory":array,"knowledgeGaps":array}`;

export const DEFAULT_ASSISTANT_PROMPT_TEMPLATE = "Верну только JSON. Profile memory не сохраняю автоматически.";

export const DEFAULT_SETTINGS: AdminSettings = {
  llmProvider: "openai",
  llmModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  sttProvider: "assemblyai",
  sttModel: "best",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
  assistantPromptTemplate: DEFAULT_ASSISTANT_PROMPT_TEMPLATE,
  promptVariables: { workingMemoryLimit: 12 },
  providerMetadata: {},
  ragEnabled: false,
  ragConfig: { embeddingModel: "text-embedding-3-small", topK: 6 },
  mcpEnabled: false,
  mcpServers: [],
  updatedAt: new Date(0).toISOString(),
};

export async function getAdminSettings(): Promise<AdminSettings> {
  await ensureAppSchema();
  const [row] = await getSql()<SettingsRow[]>`
    select llm_provider, llm_model, stt_provider, stt_model, system_prompt, user_prompt_template,
      assistant_prompt_template, prompt_variables, provider_metadata, rag_enabled, rag_config,
      mcp_enabled, mcp_servers, updated_at
    from admin_settings where id = true limit 1
  `;

  return row ? normalizeSettingsRow(row) : DEFAULT_SETTINGS;
}

export async function updateAdminSettings(input: AdminSettingsInput): Promise<AdminSettings> {
  await ensureAppSchema();
  const current = await getAdminSettings();
  const next: AdminSettings = { ...current, ...normalizeSettingsInput(input), updatedAt: new Date().toISOString() };
  const [row] = await getSql()<SettingsRow[]>`
    update admin_settings set
      llm_provider = ${next.llmProvider},
      llm_model = ${next.llmModel},
      stt_provider = ${next.sttProvider},
      stt_model = ${next.sttModel},
      system_prompt = ${next.systemPrompt},
      user_prompt_template = ${next.userPromptTemplate},
      assistant_prompt_template = ${next.assistantPromptTemplate},
      prompt_variables = ${getSql().json(next.promptVariables)},
      provider_metadata = ${getSql().json(next.providerMetadata)},
      rag_enabled = ${next.ragEnabled},
      rag_config = ${getSql().json(next.ragConfig)},
      mcp_enabled = ${next.mcpEnabled},
      mcp_servers = ${getSql().json(next.mcpServers)},
      updated_at = now()
    where id = true
    returning llm_provider, llm_model, stt_provider, stt_model, system_prompt, user_prompt_template,
      assistant_prompt_template, prompt_variables, provider_metadata, rag_enabled, rag_config,
      mcp_enabled, mcp_servers, updated_at
  `;

  if (!row) throw new AppStoreError("Admin settings were not updated.");

  await getSql()`insert into memory_audit_events (id, user_login, layer, action, payload)
    values (${randomUUID()}, 'admin', 'system', 'admin_settings_updated', ${getSql().json({ llmProvider: next.llmProvider, llmModel: next.llmModel, sttModel: next.sttModel })})`;

  return normalizeSettingsRow(row);
}

function normalizeSettingsInput(input: AdminSettingsInput): AdminSettingsInput {
  const provider = input.llmProvider === "anthropic" ? "anthropic" : input.llmProvider === "openai" ? "openai" : undefined;
  return {
    ...(provider ? { llmProvider: provider } : {}),
    ...(typeof input.llmModel === "string" && input.llmModel.trim() ? { llmModel: input.llmModel.trim() } : {}),
    sttProvider: "assemblyai",
    ...(typeof input.sttModel === "string" && input.sttModel.trim() ? { sttModel: input.sttModel.trim() } : {}),
    ...(typeof input.systemPrompt === "string" ? { systemPrompt: input.systemPrompt } : {}),
    ...(typeof input.userPromptTemplate === "string" ? { userPromptTemplate: input.userPromptTemplate } : {}),
    ...(typeof input.assistantPromptTemplate === "string" ? { assistantPromptTemplate: input.assistantPromptTemplate } : {}),
    ...(input.promptVariables && typeof input.promptVariables === "object" ? { promptVariables: normalizeJsonRecord(input.promptVariables) } : {}),
    ...(input.providerMetadata && typeof input.providerMetadata === "object" ? { providerMetadata: normalizeJsonRecord(input.providerMetadata) } : {}),
    ...(typeof input.ragEnabled === "boolean" ? { ragEnabled: input.ragEnabled } : {}),
    ...(input.ragConfig && typeof input.ragConfig === "object" ? { ragConfig: normalizeJsonRecord(input.ragConfig) } : {}),
    ...(typeof input.mcpEnabled === "boolean" ? { mcpEnabled: input.mcpEnabled } : {}),
    ...(Array.isArray(input.mcpServers) ? { mcpServers: input.mcpServers } : {}),
  };
}

function normalizeSettingsRow(row: SettingsRow): AdminSettings {
  return {
    llmProvider: row.llm_provider === "anthropic" ? "anthropic" : "openai",
    llmModel: row.llm_model || DEFAULT_SETTINGS.llmModel,
    sttProvider: "assemblyai",
    sttModel: row.stt_model || DEFAULT_SETTINGS.sttModel,
    systemPrompt: row.system_prompt || DEFAULT_SETTINGS.systemPrompt,
    userPromptTemplate: row.user_prompt_template || DEFAULT_SETTINGS.userPromptTemplate,
    assistantPromptTemplate: row.assistant_prompt_template || DEFAULT_SETTINGS.assistantPromptTemplate,
    promptVariables: { ...DEFAULT_SETTINGS.promptVariables, ...normalizeJsonRecord(row.prompt_variables) },
    providerMetadata: normalizeJsonRecord(row.provider_metadata),
    ragEnabled: Boolean(row.rag_enabled),
    ragConfig: { ...DEFAULT_SETTINGS.ragConfig, ...normalizeJsonRecord(row.rag_config) },
    mcpEnabled: Boolean(row.mcp_enabled),
    mcpServers: normalizeJsonArray(row.mcp_servers),
    updatedAt: toIsoString(row.updated_at),
  };
}
