import type { AdminSettings } from "./admin-settings";
import type { ConversationMessage, InterviewAsset, InterviewBundle, InterviewRecord } from "./interview-store";
import { formatKnowledgeMemoryForPrompt, formatProfileMemoryForPrompt, type KnowledgeMemoryItem, type ProfileMemoryItem } from "./memory-store";
import type { LlmMessage } from "./llm-engine";

export type PromptBuildResult = {
  system: string;
  messages: LlmMessage[];
  promptVariables: Record<string, unknown>;
};

export function buildAnalysisPrompt(input: {
  settings: AdminSettings;
  interview: InterviewBundle;
  profileMemory: ProfileMemoryItem[];
  knowledgeMemory: KnowledgeMemoryItem[];
}): PromptBuildResult {
  const promptVariables = {
    ...input.settings.promptVariables,
    interviewContext: formatInterviewContext(input.interview),
    assetsContext: formatAssetsContext(input.interview.assets),
    transcript: input.interview.transcript || "Транскрипт пока отсутствует. Анализируй только загруженный контекст и скриншоты.",
    profileMemory: formatProfileMemoryForPrompt(input.profileMemory),
    knowledgeMemory: formatKnowledgeMemoryForPrompt(input.knowledgeMemory),
  };
  const userPrompt = renderTemplate(input.settings.userPromptTemplate, promptVariables);

  return {
    system: input.settings.systemPrompt,
    messages: [
      ...(input.settings.assistantPromptTemplate
        ? [
            {
              role: "assistant" as const,
              content: renderTemplate(input.settings.assistantPromptTemplate, promptVariables),
            },
          ]
        : []),
      {
        role: "user",
        content: userPrompt,
      },
    ],
    promptVariables,
  };
}

export function buildChatPrompt(input: {
  settings: AdminSettings;
  interview: InterviewRecord;
  profileMemory: ProfileMemoryItem[];
  knowledgeMemory: KnowledgeMemoryItem[];
  workingMessages: ConversationMessage[];
  userMessage: string;
}): PromptBuildResult {
  const workingLimit = readWorkingMemoryLimit(input.settings.promptVariables.workingMemoryLimit);
  const recentMessages = input.workingMessages.slice(-workingLimit);
  const system = `${input.settings.systemPrompt}\n\nТы сейчас отвечаешь в post-analysis чате. Используй слои памяти строго отдельно:\n\n[task memory]\n${formatTaskMemory(input.interview)}\n\n[profile memory: explicit only]\n${formatProfileMemoryForPrompt(input.profileMemory)}\n\n[knowledge memory]\n${formatKnowledgeMemoryForPrompt(input.knowledgeMemory)}\n\n[working memory policy]\nВ working memory доступны только последние ${workingLimit} сообщений текущего чата. Не записывай profile memory автоматически. Если видишь полезное долговременное наблюдение о пользователе, предложи его как candidateProfileMemory в тексте ответа, но не утверждай, что оно сохранено.`;
  const messages: LlmMessage[] = [
    ...recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: "user",
      content: input.userMessage,
    },
  ];

  return {
    system,
    messages,
    promptVariables: {
      workingMemoryLimit: workingLimit,
      loadedWorkingMessages: recentMessages.length,
      taskMemoryKeys: Object.keys(input.interview.taskMemory),
      profileMemoryItems: input.profileMemory.length,
      knowledgeMemoryItems: input.knowledgeMemory.length,
    },
  };
}

export function renderTemplate(template: string, variables: Record<string, unknown>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => stringifyTemplateValue(variables[key]));
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return { rawText: text };
      }
    }

    return { rawText: text };
  }
}

export function formatInterviewContext(interview: InterviewRecord) {
  return [
    `Компания: ${interview.company || "не указана"}`,
    `Позиция: ${interview.position || "не указана"}`,
    `Целевой уровень: ${interview.targetLevel || "не указан"}`,
    `Тип интервью: ${interview.interviewType || "не указан"}`,
    `Статус: ${interview.status}`,
  ].join("\n");
}

export function formatAssetsContext(assets: InterviewAsset[]) {
  if (assets.length === 0) {
    return "Ассеты не загружены.";
  }

  return assets
    .map((asset, index) => {
      const location = asset.sourceType === "url" ? asset.externalUrl : asset.s3Key;
      return `${index + 1}. ${asset.kind}: ${asset.originalName || "asset"}; type=${asset.contentType || "unknown"}; status=${asset.uploadStatus}; location=${location}`;
    })
    .join("\n");
}

function formatTaskMemory(interview: InterviewRecord) {
  return JSON.stringify(
    {
      company: interview.company,
      position: interview.position,
      targetLevel: interview.targetLevel,
      interviewType: interview.interviewType,
      transcriptLoaded: Boolean(interview.transcript),
      taskMemory: interview.taskMemory,
      llmOutput: interview.llmOutput,
    },
    null,
    2,
  );
}

function stringifyTemplateValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

function readWorkingMemoryLimit(value: unknown) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 12;
  }

  return Math.min(Math.max(Math.floor(number), 4), 40);
}
