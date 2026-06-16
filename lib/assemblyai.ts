import { AppStoreError, isRecord } from "./db";

const ASSEMBLYAI_TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";
const ASSEMBLYAI_TIMEOUT_MS = 30_000;

export type AssemblyAITranscript = {
  id: string;
  status: string;
  text: string;
  raw: unknown;
};

export async function submitAssemblyAITranscript(input: {
  audioUrl: string;
  speechModel?: string;
  languageCode?: string;
}): Promise<AssemblyAITranscript> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  if (!apiKey) {
    throw new AppStoreError("ASSEMBLYAI_API_KEY is not configured.");
  }

  const speechModels = normalizeSpeechModels(input.speechModel);
  const body = {
    audio_url: input.audioUrl,
    ...(speechModels.length > 0 ? { speech_models: speechModels } : {}),
    ...(input.languageCode ? { language_code: input.languageCode } : {}),
    speaker_labels: true,
    punctuate: true,
    format_text: true,
  };

  const response = await fetchAssemblyAI(ASSEMBLYAI_TRANSCRIPT_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await readJsonOrText(response);

  if (!response.ok) {
    throw new AppStoreError(extractErrorMessage(raw) || `AssemblyAI request failed with ${response.status}.`, response.status);
  }

  return normalizeTranscript(raw);
}

export async function getAssemblyAITranscript(id: string): Promise<AssemblyAITranscript> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  if (!apiKey) {
    throw new AppStoreError("ASSEMBLYAI_API_KEY is not configured.");
  }

  const response = await fetchAssemblyAI(`${ASSEMBLYAI_TRANSCRIPT_URL}/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: apiKey,
    },
  });
  const raw = await readJsonOrText(response);

  if (!response.ok) {
    throw new AppStoreError(extractErrorMessage(raw) || `AssemblyAI request failed with ${response.status}.`, response.status);
  }

  return normalizeTranscript(raw);
}

function normalizeTranscript(raw: unknown): AssemblyAITranscript {
  if (!isRecord(raw)) {
    return {
      id: "",
      status: "unknown",
      text: "",
      raw,
    };
  }

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    status: typeof raw.status === "string" ? raw.status : "unknown",
    text: typeof raw.text === "string" ? raw.text : "",
    raw,
  };
}

async function fetchAssemblyAI(url: string, init: RequestInit) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(ASSEMBLYAI_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AssemblyAI request failed.";
    throw new AppStoreError(`AssemblyAI request timed out or failed: ${message}`, 504);
  }
}

export function normalizeSpeechModels(value: string | undefined) {
  if (!value?.trim()) {
    return [];
  }

  const normalized = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalized.length === 0 || normalized.includes("best")) {
    return ["universal-2"];
  }

  return normalized;
}

async function readJsonOrText(response: Response) {
  const text = await response.text();

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorMessage(raw: unknown) {
  if (isRecord(raw) && typeof raw.error === "string") {
    return raw.error;
  }

  if (isRecord(raw) && isRecord(raw.error) && typeof raw.error.message === "string") {
    return raw.error.message;
  }

  return "";
}
