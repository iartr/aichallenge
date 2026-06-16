import { requireAuthenticatedUser } from "@/lib/auth";
import { getAdminSettings } from "@/lib/admin-settings";
import { getAssemblyAITranscript, submitAssemblyAITranscript } from "@/lib/assemblyai";
import { AppStoreError, normalizeJsonRecord } from "@/lib/db";
import {
  appendConversationMessage,
  createAsset,
  findRecordingAsset,
  getInterviewBundle,
  listConversationMessages,
  markAssetUploaded,
  normalizeAnalysisOutput,
  recordAudit,
  saveLlmRun,
  updateInterviewPatch,
  type AssetKind,
} from "@/lib/interview-store";
import { generateText } from "@/lib/llm-engine";
import { listKnowledgeMemory, listProfileMemory } from "@/lib/memory-store";
import { buildAnalysisPrompt, buildChatPrompt, extractJsonObject } from "@/lib/prompt-builder";
import { createPresignedS3Url, createS3ObjectKey } from "@/lib/s3-storage";
import { errorToResponse, readJsonBody, readOptionalString, readRequiredString } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = requireAuthenticatedUser(request);
    const { id } = await context.params;
    const body = await readJsonBody(request);
    const action = readRequiredString(body, "action", 80);

    switch (action) {
      case "presign_upload":
        return Response.json(await presignUpload(user.login, id, body));
      case "register_url_asset":
        return Response.json(await registerUrlAsset(user.login, id, body));
      case "mark_uploaded":
        return Response.json(await markUploaded(user.login, id, body));
      case "transcribe":
        return Response.json(await transcribeInterview(user.login, id, body));
      case "analyze":
        return Response.json(await analyzeInterview(user.login, id));
      case "chat":
        return Response.json(await chatAboutInterview(user.login, id, body));
      default:
        throw new AppStoreError(`Unsupported action: ${action}.`, 400);
    }
  } catch (error) {
    return errorToResponse(error);
  }
}

async function presignUpload(userLogin: string, interviewId: string, body: Record<string, unknown>) {
  const interview = await getInterviewBundle(userLogin, interviewId);
  if (!interview) throw new AppStoreError("Interview not found.", 404);

  const kind = readAssetKind(body.kind);
  const fileName = readRequiredString(body, "fileName", 240);
  const contentType = readOptionalString(body, "contentType", 240) || "application/octet-stream";
  const sizeBytes = Number(body.sizeBytes ?? 0);
  const s3Key = createS3ObjectKey({ interviewId, kind, fileName });
  const asset = await createAsset(interviewId, {
    kind,
    sourceType: "s3",
    originalName: fileName,
    contentType,
    sizeBytes: Number.isFinite(sizeBytes) ? Math.max(0, Math.floor(sizeBytes)) : 0,
    s3Key,
    uploadStatus: "pending_upload",
  });
  const uploadUrl = createPresignedS3Url({ method: "PUT", key: s3Key, contentType, expiresSeconds: 3600 });
  await recordAudit(userLogin, interviewId, "task", "asset_upload_presigned", { assetId: asset.id, kind, s3Key });

  return { asset, upload: { method: "PUT", url: uploadUrl, headers: { "Content-Type": contentType }, expiresSeconds: 3600 } };
}

async function registerUrlAsset(userLogin: string, interviewId: string, body: Record<string, unknown>) {
  const interview = await getInterviewBundle(userLogin, interviewId);
  if (!interview) throw new AppStoreError("Interview not found.", 404);

  const kind = readAssetKind(body.kind);
  const externalUrl = readRequiredString(body, "url", 4000);
  const asset = await createAsset(interviewId, {
    kind,
    sourceType: "url",
    externalUrl,
    originalName: readOptionalString(body, "name", 240) || externalUrl,
    uploadStatus: "ready",
  });
  await recordAudit(userLogin, interviewId, "task", "url_asset_registered", { assetId: asset.id, kind, externalUrl });
  return { asset };
}

async function markUploaded(userLogin: string, interviewId: string, body: Record<string, unknown>) {
  const assetId = readRequiredString(body, "assetId", 80);
  const asset = await markAssetUploaded(userLogin, interviewId, assetId);
  if (!asset) throw new AppStoreError("Asset not found.", 404);
  await updateInterviewPatch(userLogin, interviewId, { status: "uploaded" });
  return { asset };
}

async function transcribeInterview(userLogin: string, interviewId: string, body: Record<string, unknown>) {
  const settings = await getAdminSettings();
  const existingTranscriptId = readOptionalString(body, "transcriptId", 120);

  if (existingTranscriptId) {
    const transcript = await getAssemblyAITranscript(existingTranscriptId);
    const patch = transcript.status === "completed"
      ? { status: "transcribed" as const, transcript: transcript.text, transcriptMetadata: { assemblyai: transcript.raw }, errorMessage: "" }
      : transcript.status === "error"
        ? { status: "error" as const, transcriptMetadata: { assemblyai: transcript.raw }, errorMessage: "AssemblyAI transcription failed." }
        : { status: "transcribing" as const, transcriptMetadata: { assemblyai: transcript.raw } };
    const interview = await updateInterviewPatch(userLogin, interviewId, patch);
    return { transcript, interview };
  }

  const interview = await getInterviewBundle(userLogin, interviewId);
  if (!interview) throw new AppStoreError("Interview not found.", 404);
  const audioUrl = await resolveAudioUrl(interviewId, interview.sourceUrl);
  const transcript = await submitAssemblyAITranscript({ audioUrl, speechModel: settings.sttModel });
  const updated = await updateInterviewPatch(userLogin, interviewId, {
    status: "transcribing",
    transcriptMetadata: { assemblyai: transcript.raw, audioUrlSource: interview.sourceUrl ? "external_url" : "s3_signed_get" },
  });
  await recordAudit(userLogin, interviewId, "task", "transcription_started", { provider: "assemblyai", transcriptId: transcript.id, sttModel: settings.sttModel });
  return { transcript, interview: updated };
}

async function analyzeInterview(userLogin: string, interviewId: string) {
  const [settings, profileMemory, knowledgeMemory, interview] = await Promise.all([
    getAdminSettings(),
    listProfileMemory(userLogin, 20),
    listKnowledgeMemory(20),
    getInterviewBundle(userLogin, interviewId),
  ]);
  if (!interview) throw new AppStoreError("Interview not found.", 404);

  const prompt = buildAnalysisPrompt({ settings, interview, profileMemory, knowledgeMemory });
  await updateInterviewPatch(userLogin, interviewId, { status: "analyzing", errorMessage: "" });
  const result = await generateText({ provider: settings.llmProvider, model: settings.llmModel, system: prompt.system, messages: prompt.messages, maxTokens: 6000 });
  const parsed = normalizeAnalysisOutput(extractJsonObject(result.outputText));
  const taskMemory = normalizeJsonRecord(parsed.taskMemory);
  const nextTaskMemory = {
    ...interview.taskMemory,
    ...taskMemory,
    transcript: interview.transcript,
    assets: interview.assets.map((asset) => ({ id: asset.id, kind: asset.kind, name: asset.originalName, sourceType: asset.sourceType })),
    analysisSummary: typeof parsed.summary === "string" ? parsed.summary : "",
    analyzedAt: new Date().toISOString(),
  };
  const updated = await updateInterviewPatch(userLogin, interviewId, {
    status: "analyzed",
    taskMemory: nextTaskMemory,
    llmOutput: parsed,
    providerMetadata: { provider: result.provider, model: result.model, usage: result.usage },
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
  await recordAudit(userLogin, interviewId, "task", "task_memory_written", { keys: Object.keys(nextTaskMemory) });
  if (Array.isArray(parsed.candidateProfileMemory) && parsed.candidateProfileMemory.length > 0) {
    await recordAudit(userLogin, interviewId, "profile", "profile_memory_suggested_not_saved", { candidates: parsed.candidateProfileMemory });
  }
  return { interview: updated, analysis: parsed };
}

async function chatAboutInterview(userLogin: string, interviewId: string, body: Record<string, unknown>) {
  const message = readRequiredString(body, "message", 12000);
  const [settings, profileMemory, knowledgeMemory, interview, workingMessages] = await Promise.all([
    getAdminSettings(),
    listProfileMemory(userLogin, 20),
    listKnowledgeMemory(20),
    getInterviewBundle(userLogin, interviewId),
    listConversationMessages(userLogin, interviewId, 200),
  ]);
  if (!interview) throw new AppStoreError("Interview not found.", 404);

  const prompt = buildChatPrompt({ settings, interview, profileMemory, knowledgeMemory, workingMessages, userMessage: message });
  await appendConversationMessage(userLogin, interviewId, "user", message, { memoryLayer: "working" });
  const result = await generateText({ provider: settings.llmProvider, model: settings.llmModel, system: prompt.system, messages: prompt.messages, maxTokens: 3000 });
  const assistantMessage = await appendConversationMessage(userLogin, interviewId, "assistant", result.outputText, { provider: result.provider, model: result.model, usage: result.usage, memoryLayer: "working" });
  await saveLlmRun({
    userLogin,
    interviewId,
    runType: "chat",
    provider: result.provider,
    model: result.model,
    promptVariables: prompt.promptVariables,
    inputMessages: prompt.messages,
    output: { text: result.outputText },
    providerMetadata: { usage: result.usage, raw: result.raw },
  });
  return { message: assistantMessage, workingMemory: { sentMessages: prompt.promptVariables.loadedWorkingMessages, limit: prompt.promptVariables.workingMemoryLimit } };
}

async function resolveAudioUrl(interviewId: string, sourceUrl: string) {
  if (sourceUrl) return sourceUrl;
  const asset = await findRecordingAsset(interviewId);
  if (!asset) throw new AppStoreError("No recording asset or source URL is attached.", 400);
  if (asset.sourceType === "url") return asset.externalUrl;
  if (!asset.s3Key) throw new AppStoreError("Recording asset has no S3 key.", 400);
  return createPresignedS3Url({ method: "GET", key: asset.s3Key, expiresSeconds: 3600 * 6 });
}

function readAssetKind(value: unknown): AssetKind {
  if (value === "recording" || value === "screenshot") return value;
  throw new AppStoreError("kind must be recording or screenshot.", 400);
}
