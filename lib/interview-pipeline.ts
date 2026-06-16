import { getAdminSettings } from "./admin-settings";
import { resolvePublicMediaUrl } from "./audio-source";
import { getAssemblyAITranscript, submitAssemblyAITranscript, type AssemblyAITranscript } from "./assemblyai";
import { AppStoreError, isRecord, normalizeJsonRecord } from "./db";
import {
  findRecordingAsset,
  getInterview,
  getInterviewBundle,
  normalizeAnalysisOutput,
  recordAudit,
  saveLlmRun,
  updateInterviewPatch,
  type InterviewRecord,
  type InterviewStatus,
} from "./interview-store";
import { generateText } from "./llm-engine";
import { listKnowledgeMemory, listProfileMemory } from "./memory-store";
import { buildAnalysisPrompt, extractJsonObject } from "./prompt-builder";
import { createPresignedS3Url } from "./s3-storage";

const POLL_INTERVAL_MS = 5_000;
const MAX_PIPELINE_MS = 30 * 60_000;
const MAX_POLL_FAILURES = 12;
const EXPECTED_TRANSCRIBE_MS = 4 * 60_000;
const STALE_MS = 90_000;

export type PipelineStage = "queued" | "resolving" | "transcribing" | "analyzing" | "done" | "error";

export type PipelineState = {
  stage: PipelineStage;
  percent: number;
  message: string;
  transcriptId?: string;
  startedAt: string;
  updatedAt: string;
  errorCode?: string;
};

// Guard so a single Node process never runs two loops for the same interview
// (two browser tabs, a poll resume firing while a loop is alive, etc.). Hung off
// globalThis to survive Next.js dev module reloads (same pattern as lib/db.ts).
declare global {
  var interviewPipelineInFlight: Set<string> | undefined;
}

const inFlight: Set<string> = (globalThis.interviewPipelineInFlight ??= new Set<string>());

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getPipelineState(transcriptMetadata: Record<string, unknown>): PipelineState | null {
  const pipeline = transcriptMetadata.pipeline;

  return isRecord(pipeline) ? (pipeline as PipelineState) : null;
}

export function readStoredAssemblyAITranscriptId(transcriptMetadata: Record<string, unknown>): string {
  const assemblyai = transcriptMetadata.assemblyai;

  return isRecord(assemblyai) && typeof assemblyai.id === "string" ? assemblyai.id : "";
}

export function buildTranscriptPatch(transcript: AssemblyAITranscript, currentMetadata: Record<string, unknown>) {
  const transcriptMetadata = {
    ...currentMetadata,
    assemblyai: transcript.raw,
  };

  if (transcript.status === "completed") {
    return {
      status: "transcribed" as const,
      transcript: transcript.text,
      transcriptMetadata,
      errorMessage: "",
    };
  }

  if (transcript.status === "error") {
    return {
      status: "error" as const,
      transcriptMetadata,
      errorMessage: extractAssemblyAIError(transcript) || "AssemblyAI не смог расшифровать запись.",
    };
  }

  return {
    status: "transcribing" as const,
    transcriptMetadata,
  };
}

export async function resolveAudioUrl(interviewId: string, sourceUrl: string): Promise<string> {
  if (sourceUrl) {
    const resolved = await resolvePublicMediaUrl(sourceUrl);

    return resolved.downloadUrl;
  }

  const asset = await findRecordingAsset(interviewId);

  if (!asset) {
    throw new AppStoreError("Не прикреплён файл записи или ссылка на запись.", 400);
  }

  if (asset.sourceType === "url") {
    const resolved = await resolvePublicMediaUrl(asset.externalUrl);

    return resolved.downloadUrl;
  }

  if (!asset.s3Key) {
    throw new AppStoreError("У записи нет S3-ключа.", 400);
  }

  return createPresignedS3Url({ method: "GET", key: asset.s3Key, expiresSeconds: 3600 * 6 });
}

export async function submitTranscription(userLogin: string, interviewId: string) {
  const settings = await getAdminSettings();
  const interview = await getInterviewBundle(userLogin, interviewId);

  if (!interview) {
    throw new AppStoreError("Interview not found.", 404);
  }

  const audioUrl = await resolveAudioUrl(interviewId, interview.sourceUrl);
  const transcript = await submitAssemblyAITranscript({ audioUrl, speechModel: settings.sttModel });
  const updated = await updateInterviewPatch(userLogin, interviewId, {
    status: "transcribing",
    transcriptMetadata: {
      ...interview.transcriptMetadata,
      assemblyai: transcript.raw,
      audioUrlSource: interview.sourceUrl ? "external_url" : "s3_signed_get",
    },
  });

  await recordAudit(userLogin, interviewId, "task", "transcription_started", {
    provider: "assemblyai",
    transcriptId: transcript.id,
    sttModel: settings.sttModel,
  });

  return { transcript, interview: updated };
}

export async function refreshTranscription(userLogin: string, interviewId: string, transcriptId: string) {
  const interview = await getInterviewBundle(userLogin, interviewId);

  if (!interview) {
    throw new AppStoreError("Interview not found.", 404);
  }

  const transcript = await getAssemblyAITranscript(transcriptId);
  const updated = await updateInterviewPatch(userLogin, interviewId, buildTranscriptPatch(transcript, interview.transcriptMetadata));

  return { transcript, interview: updated };
}

export async function runAnalysis(userLogin: string, interviewId: string) {
  const [settings, profileMemory, knowledgeMemory, interview] = await Promise.all([
    getAdminSettings(),
    listProfileMemory(userLogin, 20),
    listKnowledgeMemory(20),
    getInterviewBundle(userLogin, interviewId),
  ]);

  if (!interview) {
    throw new AppStoreError("Interview not found.", 404);
  }

  const prompt = buildAnalysisPrompt({ settings, interview, profileMemory, knowledgeMemory });
  await updateInterviewPatch(userLogin, interviewId, { status: "analyzing", errorMessage: "" });
  const result = await generateText({
    provider: settings.llmProvider,
    model: settings.llmModel,
    system: prompt.system,
    messages: prompt.messages,
    maxTokens: 6000,
  });
  const parsed = normalizeAnalysisOutput(extractJsonObject(result.outputText));
  const taskMemory = normalizeJsonRecord(parsed.taskMemory);
  const nextTaskMemory = {
    ...interview.taskMemory,
    ...taskMemory,
    transcript: interview.transcript,
    assets: interview.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.originalName,
      sourceType: asset.sourceType,
    })),
    analysisSummary: typeof parsed.summary === "string" ? parsed.summary : "",
    analyzedAt: new Date().toISOString(),
  };
  const updated = await updateInterviewPatch(userLogin, interviewId, {
    status: "analyzed",
    taskMemory: nextTaskMemory,
    llmOutput: parsed,
    providerMetadata: {
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    },
  });

  await saveLlmRun({
    userLogin,
    interviewId,
    runType: "analysis",
    provider: result.provider,
    model: result.model,
    promptVariables: prompt.promptVariables,
    inputMessages: prompt.messages,
    output: parsed,
    providerMetadata: { usage: result.usage, raw: result.raw },
  });

  await recordAudit(userLogin, interviewId, "task", "task_memory_written", {
    keys: Object.keys(nextTaskMemory),
  });

  if (Array.isArray(parsed.candidateProfileMemory) && parsed.candidateProfileMemory.length > 0) {
    await recordAudit(userLogin, interviewId, "profile", "profile_memory_suggested_not_saved", {
      candidates: parsed.candidateProfileMemory,
    });
  }

  return { interview: updated, analysis: parsed };
}

/**
 * Kicks off (or restarts) the full auto-pipeline and returns the interview with
 * its initial progress already set, so the UI flips out of draft immediately.
 * The heavy work runs detached — see runPipeline.
 */
export async function startPipeline(userLogin: string, interviewId: string): Promise<InterviewRecord | null> {
  const interview = await getInterviewBundle(userLogin, interviewId);

  if (!interview) {
    throw new AppStoreError("Interview not found.", 404);
  }

  if (interview.status === "analyzed") {
    return interview;
  }

  const hasTranscript = Boolean(interview.transcript);
  const patched = await writePipeline(
    userLogin,
    interviewId,
    {
      stage: hasTranscript ? "analyzing" : "queued",
      percent: hasTranscript ? 82 : 4,
      message: hasTranscript ? "Анализируем ответы…" : "Запускаем разбор…",
      startedAt: new Date().toISOString(),
      errorCode: undefined,
    },
    { status: hasTranscript ? "analyzing" : "transcribing", errorMessage: "" },
  );

  void runPipeline(userLogin, interviewId).catch(() => undefined);

  return patched ?? interview;
}

export function shouldResume(interview: Pick<InterviewRecord, "id" | "status" | "transcriptMetadata">): boolean {
  if (inFlight.has(interview.id)) {
    return false;
  }

  if (interview.status !== "transcribing" && interview.status !== "analyzing") {
    return false;
  }

  const pipeline = getPipelineState(interview.transcriptMetadata);

  if (!pipeline) {
    return true;
  }

  if (pipeline.stage === "done" || pipeline.stage === "error") {
    return false;
  }

  return isStale(pipeline);
}

export function resumePipeline(userLogin: string, interviewId: string) {
  void runPipeline(userLogin, interviewId).catch(() => undefined);
}

/**
 * The detached state machine: resolve → submit → poll AssemblyAI → analyze.
 * Idempotent and safe to re-enter; never throws to its caller (it persists any
 * failure as an error state instead), so a fire-and-forget call can't crash the
 * Node process.
 */
export async function runPipeline(userLogin: string, interviewId: string): Promise<void> {
  if (inFlight.has(interviewId)) {
    return;
  }

  inFlight.add(interviewId);

  try {
    let interview = await getInterviewBundle(userLogin, interviewId);

    if (!interview) {
      return;
    }

    if (interview.status === "analyzed") {
      await writePipeline(userLogin, interviewId, { stage: "done", percent: 100, message: "Готово" });
      return;
    }

    const startMs = pipelineStartMs(interview.transcriptMetadata);

    // Stage 1 + 2: get a completed transcript (skip if we already have one).
    if (!interview.transcript) {
      let transcriptId = readStoredAssemblyAITranscriptId(interview.transcriptMetadata);

      if (!transcriptId) {
        await writePipeline(
          userLogin,
          interviewId,
          { stage: "resolving", percent: 10, message: "Получаем файл по ссылке…" },
          { status: "transcribing" },
        );
        const { transcript } = await submitTranscription(userLogin, interviewId);
        transcriptId = transcript.id;
        await writePipeline(userLogin, interviewId, {
          stage: "transcribing",
          percent: 22,
          message: "Расшифровываем запись…",
          transcriptId,
        });
      }

      let consecutiveFailures = 0;

      while (true) {
        if (Date.now() - startMs > MAX_PIPELINE_MS) {
          throw new AppStoreError("Расшифровка заняла слишком долго. Попробуй запустить разбор ещё раз.", 504);
        }

        let transcript: AssemblyAITranscript;

        try {
          transcript = await getAssemblyAITranscript(transcriptId);
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;

          if (!isTransientError(error) || consecutiveFailures >= MAX_POLL_FAILURES) {
            throw error;
          }

          // Transient network/TLS blip — back off and keep polling. Still bounded
          // by MAX_PIPELINE_MS, so this can't spin forever.
          await sleep(POLL_INTERVAL_MS * Math.min(consecutiveFailures, 4));
          continue;
        }

        if (transcript.status === "completed") {
          const current = await getInterview(userLogin, interviewId);
          await updateInterviewPatch(userLogin, interviewId, buildTranscriptPatch(transcript, current?.transcriptMetadata ?? {}));
          break;
        }

        if (transcript.status === "error") {
          throw new AppStoreError(extractAssemblyAIError(transcript) || "AssemblyAI не смог расшифровать запись.", 502);
        }

        await writePipeline(userLogin, interviewId, {
          stage: "transcribing",
          percent: rampPercent(startMs),
          message: "Расшифровываем запись…",
          transcriptId,
        });
        await sleep(POLL_INTERVAL_MS);
      }
    }

    // Stage 3: analyze (skip if somehow already analyzed).
    interview = await getInterviewBundle(userLogin, interviewId);

    if (interview && interview.status !== "analyzed") {
      await writePipeline(userLogin, interviewId, { stage: "analyzing", percent: 85, message: "Анализируем ответы…" }, { status: "analyzing" });
      await runAnalysis(userLogin, interviewId);
    }

    await writePipeline(userLogin, interviewId, { stage: "done", percent: 100, message: "Готово" });
  } catch (error) {
    const rawMessage =
      error instanceof AppStoreError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Не удалось выполнить разбор.";
    const message = friendlyError(rawMessage);

    try {
      await updateInterviewPatch(userLogin, interviewId, { status: "error", errorMessage: message });
      await writePipeline(userLogin, interviewId, { stage: "error", message, errorCode: classifyError(rawMessage) });
    } catch {
      // Swallow — never let the detached task reject.
    }
  } finally {
    inFlight.delete(interviewId);
  }
}

async function writePipeline(
  userLogin: string,
  interviewId: string,
  patch: Partial<PipelineState>,
  opts: { status?: InterviewStatus; errorMessage?: string } = {},
): Promise<InterviewRecord | null> {
  const interview = await getInterview(userLogin, interviewId);

  if (!interview) {
    return null;
  }

  const previous = getPipelineState(interview.transcriptMetadata) ?? ({} as Partial<PipelineState>);
  const now = new Date().toISOString();
  const pipeline: PipelineState = {
    stage: patch.stage ?? previous.stage ?? "queued",
    percent: patch.percent ?? previous.percent ?? 0,
    message: patch.message ?? previous.message ?? "",
    transcriptId: patch.transcriptId ?? previous.transcriptId,
    startedAt: patch.startedAt ?? previous.startedAt ?? now,
    updatedAt: now,
    errorCode: "errorCode" in patch ? patch.errorCode : previous.errorCode,
  };

  return updateInterviewPatch(userLogin, interviewId, {
    transcriptMetadata: { ...interview.transcriptMetadata, pipeline },
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
  });
}

function pipelineStartMs(transcriptMetadata: Record<string, unknown>): number {
  const pipeline = getPipelineState(transcriptMetadata);
  const parsed = pipeline?.startedAt ? Date.parse(pipeline.startedAt) : NaN;

  return Number.isFinite(parsed) ? parsed : Date.now();
}

function rampPercent(startMs: number): number {
  const elapsed = Date.now() - startMs;
  const ramped = 22 + Math.floor((elapsed / EXPECTED_TRANSCRIBE_MS) * 53);

  return Math.min(75, Math.max(22, ramped));
}

function isStale(pipeline: PipelineState): boolean {
  const updated = pipeline.updatedAt ? Date.parse(pipeline.updatedAt) : NaN;

  if (!Number.isFinite(updated)) {
    return true;
  }

  return Date.now() - updated > STALE_MS;
}

function extractAssemblyAIError(transcript: AssemblyAITranscript): string {
  return isRecord(transcript.raw) && typeof transcript.raw.error === "string" ? transcript.raw.error : "";
}

function isTransientError(error: unknown): boolean {
  if (error instanceof AppStoreError) {
    // 504 = our network/timeout wrapper; 429/5xx from AssemblyAI are worth retrying.
    return error.status === 504 || error.status === 429 || error.status >= 500;
  }

  return isNetworkErrorMessage(error instanceof Error ? error.message : String(error));
}

function isNetworkErrorMessage(message: string): boolean {
  return /ssl|tls|decryption|bad record mac|fetch failed|econn|epipe|socket|network|terminated|und_err/i.test(message);
}

function friendlyError(message: string): string {
  if (isNetworkErrorMessage(message)) {
    return "Сетевая ошибка при загрузке или расшифровке записи. Попробуй запустить разбор ещё раз.";
  }

  return message;
}

function classifyError(message: string): string {
  const lower = message.toLowerCase();

  if (isNetworkErrorMessage(message)) {
    return "network";
  }

  if (lower.includes("ссыл") || lower.includes("яндекс") || lower.includes("файл")) {
    return "resolve_failed";
  }

  if (lower.includes("слишком долго") || lower.includes("timed out") || lower.includes("timeout")) {
    return "timeout";
  }

  if (lower.includes("assemblyai")) {
    return "aai_error";
  }

  return "failed";
}
