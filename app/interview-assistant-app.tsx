"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Interview = {
  id: string;
  company: string;
  position: string;
  targetLevel: string;
  interviewType: string;
  status: string;
  sourceUrl: string;
  taskMemory: Record<string, unknown>;
  llmOutput: Record<string, unknown>;
  transcript: string;
  transcriptMetadata: Record<string, unknown>;
  errorMessage: string;
  assets?: Asset[];
  messages?: ChatMessage[];
  updatedAt: string;
};

type Asset = {
  id: string;
  kind: "recording" | "screenshot";
  originalName: string;
  uploadStatus: string;
  sourceType: string;
  externalUrl: string;
  s3Key: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type Settings = {
  llmProvider: "openai" | "anthropic";
  llmModel: string;
  sttModel: string;
  systemPrompt: string;
  userPromptTemplate: string;
  assistantPromptTemplate: string;
  promptVariables: Record<string, unknown>;
  ragEnabled: boolean;
  ragConfig: Record<string, unknown>;
  mcpEnabled: boolean;
  mcpServers: unknown[];
};

type MemoryItem = {
  id: string;
  statement?: string;
  title?: string;
  content?: string;
  createdAt: string;
};

type SessionResponse = {
  user?: {
    login: string;
  } | null;
};

type Screen = "landing" | "upload" | "processing" | "feedback" | "chat" | "admin";
type AdminSubtab = "models" | "prompts" | "memory" | "mcp" | "rag";
type ProcessingMode = "create" | "transcribe" | "analyze";
type LayerKey = "working" | "task" | "profile" | "knowledge";

type FeedbackView = {
  score: number | null;
  scoreCaption: string;
  summary: string;
  competencies: CompetencyView[];
  strengths: string[];
  weaknesses: string[];
  moments: MomentView[];
  recommendations: string[];
};

type CompetencyView = {
  name: string;
  score: number;
  color: string;
};

type MomentView = {
  time: string;
  tag: string;
  tagTone: "brand" | "muted";
  text: string;
};

type MemoryLayerView = {
  key: LayerKey;
  group: string;
  title: string;
  sub: string;
  dot: string;
  items: string[];
};

type IntegrationItem = {
  name: string;
  desc: string;
  on: boolean;
};

const LEVELS = ["Junior", "Junior+", "Middle", "Middle+", "Senior", "Tech Lead", "Team Lead"];
const TYPES = ["HR-скрининг", "Техническое интервью", "System Design", "Финальное интервью", "Soft skills"];
const POSITIONS = ["Android-разработчик", "iOS-разработчик", "Frontend", "Backend", "QA-инженер", "Game Dev"];

const DEFAULT_CHAT = "Как здесь можно было ответить сильнее?";

const SAMPLE_SUGGESTIONS = [
  "Как мне стоило ответить на самый слабый вопрос?",
  "Что подтянуть к следующему собеседованию?",
  "Сформулируй сильный ответ для моего уровня",
];

const LLM_OPTIONS: Array<{ label: string; provider: Settings["llmProvider"]; model: string }> = [
  { label: "OpenAI mini", provider: "openai", model: "gpt-4.1-mini" },
  { label: "GPT-4o mini", provider: "openai", model: "gpt-4o-mini" },
  { label: "Claude Sonnet", provider: "anthropic", model: "claude-3-5-sonnet-latest" },
  { label: "Current model", provider: "openai", model: "" },
];

const STT_OPTIONS = ["AssemblyAI default", "universal", "Deepgram Nova-2", "Whisper large-v3"];

export function InterviewAssistantApp() {
  const [isAuthed, setIsAuthed] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [screen, setScreen] = useState<Screen>("landing");
  const [adminTab, setAdminTab] = useState<AdminSubtab>("models");
  const [status, setStatus] = useState("Готово");
  const [error, setError] = useState("");
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Interview | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [profileMemory, setProfileMemory] = useState<MemoryItem[]>([]);
  const [knowledgeMemory, setKnowledgeMemory] = useState<MemoryItem[]>([]);
  const [recordingFile, setRecordingFile] = useState<File | null>(null);
  const [screenshotFiles, setScreenshotFiles] = useState<File[]>([]);
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("create");
  const [showPrompt, setShowPrompt] = useState(false);
  const [layerEnabled, setLayerEnabled] = useState<Record<LayerKey, boolean>>({
    working: true,
    task: true,
    profile: true,
    knowledge: true,
  });
  const [form, setForm] = useState({
    company: "",
    position: "Android-разработчик",
    targetLevel: "Middle",
    interviewType: "Техническое интервью",
    sourceUrl: "",
  });
  const [transcriptId, setTranscriptId] = useState("");
  const [chatText, setChatText] = useState(DEFAULT_CHAT);
  const [profileStatement, setProfileStatement] = useState("");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");

  const candidateProfileMemory = useMemo(() => {
    const candidates = selected?.llmOutput?.candidateProfileMemory;
    return Array.isArray(candidates) ? candidates : [];
  }, [selected]);

  const feedback = useMemo(() => deriveFeedbackView(selected), [selected]);
  const memoryLayers = useMemo(
    () => deriveMemoryLayers(selected, profileMemory, knowledgeMemory),
    [selected, profileMemory, knowledgeMemory],
  );
  const promptPreview = useMemo(
    () => buildPromptPreview(memoryLayers, layerEnabled),
    [memoryLayers, layerEnabled],
  );

  const checkSession = useCallback(async () => {
    const response = await fetch("/api/auth/session");

    if (!response.ok) {
      setIsAuthed(false);
      return;
    }

    const data = (await response.json()) as SessionResponse;
    setIsAuthed(Boolean(data.user));
  }, []);

  const loadInterviews = useCallback(async () => {
    const data = await apiGet<{ interviews: Interview[] }>("/api/interviews");
    setInterviews(data.interviews);
    setSelectedId((current) => current || data.interviews[0]?.id || "");
  }, []);

  const loadInterview = useCallback(async (id: string) => {
    const data = await apiGet<{ interview: Interview }>(`/api/interviews/${id}`);
    setSelected(data.interview);
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await apiGet<{ settings: Settings }>("/api/admin/settings");
    setSettings(data.settings);
  }, []);

  const loadMemory = useCallback(async () => {
    const [profile, knowledge] = await Promise.all([
      apiGet<{ items: MemoryItem[] }>("/api/memory/profile"),
      apiGet<{ items: MemoryItem[] }>("/api/memory/knowledge"),
    ]);
    setProfileMemory(profile.items);
    setKnowledgeMemory(knowledge.items);
  }, []);

  useEffect(() => {
    deferAsync(checkSession);
  }, [checkSession]);

  useEffect(() => {
    if (!isAuthed) {
      return;
    }

    deferAsync(async () => {
      await Promise.all([loadInterviews(), loadSettings(), loadMemory()]);
    });
  }, [isAuthed, loadInterviews, loadSettings, loadMemory]);

  useEffect(() => {
    if (selectedId) {
      deferAsync(async () => {
        await loadInterview(selectedId);
      });
    }
  }, [selectedId, loadInterview]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", password: loginPassword }),
    });

    if (!response.ok) {
      setError(await readError(response));
      return;
    }

    setIsAuthed(true);
    setScreen("landing");
  }

  async function createInterviewFlow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProcessingMode("create");
    setScreen("processing");
    setStatus("Создаю разбор");
    setError("");

    try {
      const data = await apiPost<{ interview: Interview }>("/api/interviews", {
        ...form,
        sourceType: form.sourceUrl ? "url" : "upload",
      });
      const interviewId = data.interview.id;

      if (recordingFile) {
        await uploadFile(interviewId, "recording", recordingFile);
      }

      for (const file of screenshotFiles.slice(0, 10)) {
        await uploadFile(interviewId, "screenshot", file);
      }

      setSelectedId(interviewId);
      await Promise.all([loadInterviews(), loadInterview(interviewId)]);
      setStatus("Разбор создан");
      setScreen("feedback");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ошибка создания разбора");
      setStatus("Ошибка");
      setScreen("upload");
    }
  }

  async function uploadFile(interviewId: string, kind: "recording" | "screenshot", file: File) {
    const { asset, upload } = await apiPost<{ asset: Asset; upload: { url: string; headers: Record<string, string> } }>(
      `/api/interviews/${interviewId}/actions`,
      {
        action: "presign_upload",
        kind,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      },
    );
    const uploadResponse = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`S3 upload failed for ${file.name}.`);
    }

    await apiPost(`/api/interviews/${interviewId}/actions`, {
      action: "mark_uploaded",
      assetId: asset.id,
    });
  }

  async function action(actionName: string, payload: Record<string, unknown> = {}) {
    if (!selectedId) {
      return;
    }

    if (actionName === "transcribe" || actionName === "analyze") {
      setProcessingMode(actionName);
      setScreen("processing");
    }

    setStatus(actionName);
    setError("");

    try {
      const data = await apiPost<Record<string, unknown>>(`/api/interviews/${selectedId}/actions`, {
        action: actionName,
        ...payload,
      });

      if (actionName === "transcribe" && isRecord(data.transcript) && typeof data.transcript.id === "string") {
        setTranscriptId(data.transcript.id);
      }

      await Promise.all([loadInterviews(), loadInterview(selectedId), loadMemory()]);
      setStatus("Готово");

      if (actionName === "transcribe" || actionName === "analyze") {
        setScreen("feedback");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
      setStatus("Ошибка");

      if (actionName === "transcribe" || actionName === "analyze") {
        setScreen("feedback");
      }
    }
  }

  async function sendChatMessage(message: string) {
    if (!message.trim()) {
      return;
    }

    setChatText("");
    await action("chat", { message });
    setScreen("chat");
  }

  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendChatMessage(chatText);
  }

  async function persistSettings() {
    if (!settings) {
      return;
    }

    setStatus("Сохраняю настройки");
    setError("");

    try {
      const data = await apiPut<{ settings: Settings }>("/api/admin/settings", settings);
      setSettings(data.settings);
      setStatus("Настройки сохранены");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Settings failed");
      setStatus("Ошибка");
    }
  }

  async function rememberProfile(statement = profileStatement) {
    if (!statement.trim()) {
      return;
    }

    await apiPost("/api/memory/profile", {
      statement,
      confirm: true,
      source: "explicit_user_action",
      interviewId: selectedId || undefined,
    });
    setProfileStatement("");
    await loadMemory();
  }

  async function addKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!knowledgeTitle.trim() || !knowledgeContent.trim()) {
      return;
    }

    await apiPost("/api/memory/knowledge", {
      title: knowledgeTitle,
      content: knowledgeContent,
    });
    setKnowledgeTitle("");
    setKnowledgeContent("");
    await loadMemory();
  }

  function go(screenName: Screen) {
    setScreen(screenName);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSelectedOrUpload(target: Screen) {
    setScreen(selected ? target : "upload");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!isAuthed) {
    return <AuthScreen loginPassword={loginPassword} setLoginPassword={setLoginPassword} login={login} error={error} />;
  }

  return (
    <main className="of-shell">
      {error ? <div className="of-error" role="alert">{error}</div> : null}

      {screen === "landing" ? (
        <LandingScreen
          status={status}
          go={go}
          openSelectedOrUpload={openSelectedOrUpload}
          interviews={interviews}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
        />
      ) : null}

      {screen === "upload" ? (
        <UploadScreen
          form={form}
          setForm={setForm}
          onSubmit={createInterviewFlow}
          recordingFile={recordingFile}
          setRecordingFile={setRecordingFile}
          screenshotFiles={screenshotFiles}
          setScreenshotFiles={setScreenshotFiles}
          go={go}
        />
      ) : null}

      {screen === "processing" ? (
        <ProcessingScreen mode={processingMode} selected={selected} form={form} status={status} go={go} />
      ) : null}

      {screen === "feedback" ? (
        <FeedbackScreen
          selected={selected}
          feedback={feedback}
          transcriptId={transcriptId}
          setTranscriptId={setTranscriptId}
          action={action}
          go={go}
        />
      ) : null}

      {screen === "chat" ? (
        <ChatScreen
          selected={selected}
          feedback={feedback}
          chatText={chatText}
          setChatText={setChatText}
          sendChat={sendChat}
          sendChatMessage={sendChatMessage}
          memoryLayers={memoryLayers}
          layerEnabled={layerEnabled}
          setLayerEnabled={setLayerEnabled}
          showPrompt={showPrompt}
          setShowPrompt={setShowPrompt}
          promptPreview={promptPreview}
          go={go}
        />
      ) : null}

      {screen === "admin" && settings ? (
        <AdminScreen
          settings={settings}
          setSettings={setSettings}
          saveSettings={persistSettings}
          adminTab={adminTab}
          setAdminTab={setAdminTab}
          selected={selected}
          interviews={interviews}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          profileMemory={profileMemory}
          knowledgeMemory={knowledgeMemory}
          profileStatement={profileStatement}
          setProfileStatement={setProfileStatement}
          rememberProfile={rememberProfile}
          candidateProfileMemory={candidateProfileMemory}
          knowledgeTitle={knowledgeTitle}
          setKnowledgeTitle={setKnowledgeTitle}
          knowledgeContent={knowledgeContent}
          setKnowledgeContent={setKnowledgeContent}
          addKnowledge={addKnowledge}
          go={go}
        />
      ) : null}
    </main>
  );
}

function AuthScreen({
  loginPassword,
  setLoginPassword,
  login,
  error,
}: {
  loginPassword: string;
  setLoginPassword: (value: string) => void;
  login: (event: FormEvent<HTMLFormElement>) => void;
  error: string;
}) {
  return (
    <main className="authScreen">
      <form className="of-login-card" onSubmit={login}>
        <Logo size="large" />
        <div>
          <div className="of-kicker">Админский доступ</div>
          <h1>OfferFactory.ai</h1>
          <p>Прототип разбора IT-собеседований с управляемыми слоями памяти.</p>
        </div>
        <input
          type="password"
          value={loginPassword}
          onChange={(event) => setLoginPassword(event.target.value)}
          placeholder="ADMIN_PASSWORD"
          autoComplete="current-password"
        />
        <button className="of-primary" type="submit">Войти</button>
        {error ? <div className="of-error inline">{error}</div> : null}
      </form>
    </main>
  );
}

function LandingScreen({
  status,
  go,
  openSelectedOrUpload,
  interviews,
  selectedId,
  setSelectedId,
}: {
  status: string;
  go: (screen: Screen) => void;
  openSelectedOrUpload: (screen: Screen) => void;
  interviews: Interview[];
  selectedId: string;
  setSelectedId: (id: string) => void;
}) {
  return (
    <div className="of-page">
      <div className="landing-nav-wrap">
        <header className="landing-nav">
          <Logo onClick={() => go("landing")} />
          <nav>
            <button type="button" onClick={() => go("upload")}>Как работает</button>
            <button type="button" onClick={() => go("admin")}>Для команд</button>
            <button type="button" className="of-primary sm" onClick={() => go("upload")}>Разобрать интервью</button>
          </nav>
        </header>
      </div>

      <section className="landing-hero">
        <div className="of-kicker">Транскрибация + LLM-разбор</div>
        <h1>Твоё интервью<br />стоит дороже</h1>
        <p>
          Загрузи запись собеседования — получи поминутный разбор: где поплыл, что недосказал и как ответить сильнее.
          Контекст компании, роли и уровня учитывается в анализе.
        </p>
        <div className="of-actions">
          <button type="button" className="of-primary" onClick={() => go("upload")}>Загрузить запись</button>
          <button type="button" className="of-secondary" onClick={() => openSelectedOrUpload("chat")}>
            Посмотреть разбор с ассистентом
          </button>
        </div>
      </section>

      <section className="landing-metrics">
        <MetricCard tone="brand" value="до 2 ГБ" label="аудио или видео любого формата" />
        <MetricCard value="6 ролей" label="Android, iOS, Frontend, Backend, QA, Game Dev" />
        <MetricCard value="5 типов" label="от HR-скрининга до system design" />
        <MetricCard value={status === "Готово" ? "готово" : status} label="текущий статус приложения" />
      </section>

      <section className="landing-steps">
        <h2>Как это работает</h2>
        <div className="step-grid">
          <StepCard icon="upload" title="1. Загружаешь">
            Файл, ссылка на Яндекс.Диск или Google Drive. Плюс скриншоты заданий — до 10 штук.
          </StepCard>
          <StepCard icon="mic" title="2. Мы расшифровываем">
            AssemblyAI переводит запись в текст. Дальше — LLM-анализ с контекстом роли и уровня.
          </StepCard>
          <StepCard icon="edit" title="3. Получаешь разбор">
            Оценки по компетенциям, сильные и слабые стороны, рекомендации и диалог с ассистентом.
          </StepCard>
        </div>
      </section>

      {interviews.length > 0 ? (
        <section className="recent-strip">
          <div>
            <h2>Последние разборы</h2>
            <p>История уже сохранена в Postgres. Выбери запись и открой фидбэк.</p>
          </div>
          <div className="recent-list">
            {interviews.slice(0, 4).map((interview) => (
              <button
                type="button"
                key={interview.id}
                className={selectedId === interview.id ? "recent-item active" : "recent-item"}
                onClick={() => {
                  setSelectedId(interview.id);
                  go("feedback");
                }}
              >
                <strong>{interview.company || "Без компании"}</strong>
                <span>{interview.position || "роль"} · {interview.targetLevel || "уровень"}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="landing-cta">
        <div>
          <h2>Найдём, что стоило ответить иначе</h2>
          <p>Первый smoke-разбор можно прогнать на коротком аудио и безопасной mini-модели.</p>
        </div>
        <button type="button" onClick={() => go("upload")}>Разобрать интервью</button>
      </section>
    </div>
  );
}

function UploadScreen({
  form,
  setForm,
  onSubmit,
  recordingFile,
  setRecordingFile,
  screenshotFiles,
  setScreenshotFiles,
  go,
}: {
  form: { company: string; position: string; targetLevel: string; interviewType: string; sourceUrl: string };
  setForm: (value: { company: string; position: string; targetLevel: string; interviewType: string; sourceUrl: string }) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  recordingFile: File | null;
  setRecordingFile: (file: File | null) => void;
  screenshotFiles: File[];
  setScreenshotFiles: (files: File[]) => void;
  go: (screen: Screen) => void;
}) {
  return (
    <div className="of-app-page">
      <AppTopBar label="Шаг 1 из 3 · Загрузка" go={go} />
      <div className="of-container">
        <PageIntro title="Загрузи запись">
          Чем точнее контекст — тем полезнее разбор. Заполни роль, тип интервью и целевой уровень.
        </PageIntro>

        <form className="upload-layout" onSubmit={onSubmit}>
          <div className="upload-left">
            <label className="dropzone">
              <input
                className="sr-only"
                type="file"
                accept="audio/*,video/*"
                onChange={(event) => setRecordingFile(event.target.files?.[0] ?? null)}
              />
              <Icon name="upload" size={26} />
              <strong>Перетащи файл сюда</strong>
              <span>MP4, MOV, MP3, WAV, M4A и другие · до 2 ГБ</span>
              <em>{recordingFile ? `${recordingFile.name} · ${formatFileSize(recordingFile.size)}` : "Можно выбрать файл или указать ссылку ниже"}</em>
            </label>

            <div className="source-grid">
              <div><strong>С устройства</strong><span>файл</span></div>
              <div><strong>Яндекс.Диск</strong><span>по ссылке</span></div>
              <div><strong>Google Drive</strong><span>по ссылке</span></div>
            </div>

            <label className="link-panel">
              <span>Ссылка на запись</span>
              <input
                value={form.sourceUrl}
                onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })}
                placeholder="https://storage.googleapis.com/aai-web-samples/5_common_sports_injuries.mp3"
              />
            </label>

            <label className="screens-panel">
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => setScreenshotFiles(Array.from(event.target.files ?? []).slice(0, 10))}
              />
              <div className="panel-row">
                <strong>Скриншоты заданий</strong>
                <span>{screenshotFiles.length} / 10</span>
              </div>
              <div className="shot-list">
                {Array.from({ length: Math.max(1, Math.min(screenshotFiles.length + 1, 5)) }).map((_, index) => (
                  <span key={index} className={index < screenshotFiles.length ? "shot filled" : "shot add"}>
                    <Icon name={index < screenshotFiles.length ? "image" : "plus"} size={20} />
                  </span>
                ))}
              </div>
            </label>
          </div>

          <div className="context-card">
            <FieldLabel label="Компания">
              <input
                value={form.company}
                onChange={(event) => setForm({ ...form, company: event.target.value })}
                placeholder="например, Avito"
              />
            </FieldLabel>

            <PillGroup
              label="Роль"
              options={POSITIONS}
              value={form.position}
              onChange={(position) => setForm({ ...form, position })}
            />
            <PillGroup
              label="Тип интервью"
              options={TYPES}
              value={form.interviewType}
              onChange={(interviewType) => setForm({ ...form, interviewType })}
            />
            <PillGroup
              label="Целевой уровень"
              options={LEVELS}
              value={form.targetLevel}
              onChange={(targetLevel) => setForm({ ...form, targetLevel })}
            />
            <button className="of-primary wide" type="submit">Начать разбор</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProcessingScreen({
  mode,
  selected,
  form,
  status,
  go,
}: {
  mode: ProcessingMode;
  selected: Interview | null;
  form: { company: string; position: string; targetLevel: string; interviewType: string };
  status: string;
  go: (screen: Screen) => void;
}) {
  const progress = mode === "create" ? 42 : mode === "transcribe" ? 62 : 84;
  const stages = [
    { label: "Загрузка файла", active: mode === "create" || selected?.assets?.length },
    { label: "Транскрибация (AssemblyAI)", active: mode === "transcribe" || Boolean(selected?.transcript) },
    { label: "LLM-анализ", active: mode === "analyze" || selected?.status === "analyzed" },
    { label: "Готово", active: status === "Готово" || selected?.status === "analyzed" },
  ];

  return (
    <div className="of-app-page min-screen">
      <AppTopBar label="Шаг 2 из 3 · Обработка" go={go} />
      <div className="processing-wrap">
        <div className="processing-card">
          <div className="of-overline">
            {(selected?.company || form.company || "Интервью")} · {(selected?.position || form.position)} · {(selected?.targetLevel || form.targetLevel)}
          </div>
          <h1>Разбираем запись</h1>
          <div className="progress-number">
            <strong>{progress}</strong>
            <span>%</span>
          </div>
          <div className="progress-bar"><span style={{ width: `${progress}%` }} /></div>
          <div className="stage-list">
            {stages.map((stage, index) => (
              <div key={stage.label} className={stage.active ? "stage active" : "stage"}>
                <span>{index + 1}</span>
                <strong>{stage.label}</strong>
              </div>
            ))}
          </div>
          <button className="of-primary wide" type="button" onClick={() => go("feedback")}>Открыть разбор</button>
        </div>
        <p>Тестируем приложение... обычно занимает несколько минут на запись длиной в час.</p>
      </div>
    </div>
  );
}

function FeedbackScreen({
  selected,
  feedback,
  transcriptId,
  setTranscriptId,
  action,
  go,
}: {
  selected: Interview | null;
  feedback: FeedbackView;
  transcriptId: string;
  setTranscriptId: (value: string) => void;
  action: (actionName: string, payload?: Record<string, unknown>) => Promise<void>;
  go: (screen: Screen) => void;
}) {
  if (!selected) {
    return (
      <div className="of-app-page min-screen">
        <AppTopBar label="Шаг 3 из 3 · Разбор" go={go} right={<button type="button" className="of-secondary sm" onClick={() => go("upload")}>Новый разбор</button>} />
        <EmptyState title="Разбор не выбран" text="Создай новое интервью или выбери сохраненный разбор на главной." />
      </div>
    );
  }

  return (
    <div className="of-app-page">
      <AppTopBar
        label="Шаг 3 из 3 · Фидбэк"
        go={go}
        right={<button type="button" className="of-primary sm" onClick={() => go("chat")}>Обсудить с ассистентом</button>}
      />
      <div className="of-container feedback-container">
        <section className="feedback-hero-card">
          <div>
            <div className="of-overline">{selected.company || "Компания не указана"} · {selected.interviewType || "Интервью"}</div>
            <h1>Разбор интервью</h1>
            <p>{selected.position || "роль"} · цель: {selected.targetLevel || "уровень"} · {selected.transcript ? "транскрипт загружен" : "транскрипт ожидается"}</p>
          </div>
          <div className="score-box">
            <strong>{feedback.score === null ? "--" : feedback.score.toFixed(1)}</strong>
            <span>{feedback.scoreCaption}</span>
          </div>
        </section>

        {selected.status !== "analyzed" ? (
          <section className="action-panel">
            <div>
              <h2>Реальные действия</h2>
              <p>Можно запустить транскрибацию, проверить AssemblyAI job или сразу выполнить короткий LLM-анализ.</p>
            </div>
            <div className="action-buttons">
              <button type="button" onClick={() => action("transcribe")}>Запустить AssemblyAI</button>
              <label>
                <input value={transcriptId} onChange={(event) => setTranscriptId(event.target.value)} placeholder="AssemblyAI transcript id" />
                <button type="button" onClick={() => action("transcribe", { transcriptId })}>Проверить</button>
              </label>
              <button type="button" className="of-primary" onClick={() => action("analyze")}>Запустить LLM-анализ</button>
            </div>
          </section>
        ) : null}

        <section className="of-card competencies-card">
          <h2>Оценка по компетенциям</h2>
          <div className="competency-list">
            {feedback.competencies.map((competency) => (
              <div key={competency.name}>
                <div className="competency-head">
                  <span>{competency.name}</span>
                  <strong style={{ color: competency.color }}>{competency.score.toFixed(1)}</strong>
                </div>
                <div className="mini-bar"><span style={{ width: `${Math.min(100, Math.max(0, competency.score * 10))}%`, background: competency.color }} /></div>
              </div>
            ))}
          </div>
        </section>

        <div className="two-card-grid">
          <InsightCard icon="check" title="Сильные стороны" items={feedback.strengths} />
          <InsightCard icon="alert" title="Слабые места" items={feedback.weaknesses} muted />
        </div>

        <section className="of-card">
          <h2>Ключевые моменты по таймкодам</h2>
          <div className="moment-list">
            {feedback.moments.map((moment) => (
              <div key={`${moment.time}-${moment.text}`} className="moment-row">
                <time>{moment.time}</time>
                <div>
                  <span className={moment.tagTone === "brand" ? "tag brand" : "tag"}>{moment.tag}</span>
                  <p>{moment.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="of-card">
          <h2>Рекомендации</h2>
          <div className="recommendation-list">
            {feedback.recommendations.map((recommendation, index) => (
              <div key={recommendation}>
                <span>{index + 1}</span>
                <p>{recommendation}</p>
              </div>
            ))}
          </div>
          <button type="button" className="of-primary" onClick={() => go("chat")}>Обсудить разбор с ассистентом</button>
        </section>

        <details className="transcript-details">
          <summary>Транскрипт и raw output</summary>
          <div className="debug-grid">
            <JsonBlock title="Task memory" value={selected.taskMemory} />
            <JsonBlock title="LLM output" value={selected.llmOutput} />
          </div>
          <pre className="textBlock">{selected.transcript || "Транскрипт появится после завершения AssemblyAI job."}</pre>
        </details>
      </div>
    </div>
  );
}

function ChatScreen({
  selected,
  feedback,
  chatText,
  setChatText,
  sendChat,
  sendChatMessage,
  memoryLayers,
  layerEnabled,
  setLayerEnabled,
  showPrompt,
  setShowPrompt,
  promptPreview,
  go,
}: {
  selected: Interview | null;
  feedback: FeedbackView;
  chatText: string;
  setChatText: (value: string) => void;
  sendChat: (event: FormEvent<HTMLFormElement>) => void;
  sendChatMessage: (message: string) => Promise<void>;
  memoryLayers: MemoryLayerView[];
  layerEnabled: Record<LayerKey, boolean>;
  setLayerEnabled: (value: Record<LayerKey, boolean>) => void;
  showPrompt: boolean;
  setShowPrompt: (value: boolean) => void;
  promptPreview: string;
  go: (screen: Screen) => void;
}) {
  if (!selected) {
    return (
      <div className="of-app-page min-screen">
        <AppTopBar label="Диалог" go={go} right={<button type="button" className="of-secondary sm" onClick={() => go("upload")}>Новый разбор</button>} />
        <EmptyState title="Нужен разбор" text="Сначала создай интервью, чтобы ассистент получил task memory." />
      </div>
    );
  }

  return (
    <div className="of-app-page">
      <AppTopBar label="" maxWidth="1280" go={go} right={<button type="button" className="of-secondary sm" onClick={() => go("feedback")}>← К разбору</button>} />
      <div className="chat-page">
        <section className="chat-column">
          <PageIntro title="Диалог с ассистентом" compact>
            Спроси, как стоило ответить. Ассистент помнит твой профиль и прошлые разборы.
          </PageIntro>

          <div className="chat-card">
            <div className="chat-recap">
              <Icon name="file" size={16} />
              <p>
                Контекст загружен: расшифровка интервью в <b>{selected.company || "компании"}</b>,
                разбор {feedback.score === null ? "без оценки" : `с оценкой ${feedback.score.toFixed(1)}/10`} и профиль {selected.position || "кандидата"} · {selected.targetLevel || "уровень"}.
              </p>
            </div>

            <div className="messages am-scroll" id="chatScroll">
              {(selected.messages ?? []).length > 0 ? (
                (selected.messages ?? []).map((message) => (
                  <div key={message.id} className={message.role === "user" ? "message-row user" : "message-row assistant"}>
                    <div className="message-bubble">{message.content}</div>
                    {message.role === "assistant" ? (
                      <div className="used-memory"><span>из памяти:</span><b>задача</b><b>профиль</b><b>знания</b></div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="empty-chat">
                  <Icon name="chat" size={22} />
                  <p>Задай вопрос про любой момент интервью — ассистент ответит, опираясь на память справа.</p>
                </div>
              )}
            </div>

            <div className="chat-input-zone">
              <div className="suggestions">
                {SAMPLE_SUGGESTIONS.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => sendChatMessage(suggestion)}>{suggestion}</button>
                ))}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Спроси про любой момент интервью..." />
                <button type="submit" aria-label="Отправить"><Icon name="send" size={18} /></button>
              </form>
            </div>
          </div>
        </section>

        <aside className="memory-card">
          <div className="memory-head">
            <span><Icon name="brain" size={17} /></span>
            <div>
              <h2>Память ассистента</h2>
              <p>что хранится и что уходит в промпт</p>
            </div>
          </div>
          <button type="button" className="prompt-toggle" onClick={() => setShowPrompt(!showPrompt)}>
            {showPrompt ? "Скрыть промпт" : "Что ушло в модель"}
          </button>
          {showPrompt ? <pre className="prompt-preview am-scroll">{promptPreview}</pre> : null}
          <div className="memory-layer-list am-scroll">
            {memoryLayers.map((layer, index) => (
              <MemoryLayerCard
                key={layer.key}
                layer={layer}
                enabled={layerEnabled[layer.key]}
                showGroup={index === 0 || memoryLayers[index - 1]?.group !== layer.group}
                onToggle={() => setLayerEnabled({ ...layerEnabled, [layer.key]: !layerEnabled[layer.key] })}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function AdminScreen({
  settings,
  setSettings,
  saveSettings,
  adminTab,
  setAdminTab,
  selected,
  interviews,
  selectedId,
  setSelectedId,
  profileMemory,
  knowledgeMemory,
  profileStatement,
  setProfileStatement,
  rememberProfile,
  candidateProfileMemory,
  knowledgeTitle,
  setKnowledgeTitle,
  knowledgeContent,
  setKnowledgeContent,
  addKnowledge,
  go,
}: {
  settings: Settings;
  setSettings: (value: Settings) => void;
  saveSettings: () => Promise<void>;
  adminTab: AdminSubtab;
  setAdminTab: (value: AdminSubtab) => void;
  selected: Interview | null;
  interviews: Interview[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  profileMemory: MemoryItem[];
  knowledgeMemory: MemoryItem[];
  profileStatement: string;
  setProfileStatement: (value: string) => void;
  rememberProfile: (statement?: string) => Promise<void>;
  candidateProfileMemory: unknown[];
  knowledgeTitle: string;
  setKnowledgeTitle: (value: string) => void;
  knowledgeContent: string;
  setKnowledgeContent: (value: string) => void;
  addKnowledge: (event: FormEvent<HTMLFormElement>) => void;
  go: (screen: Screen) => void;
}) {
  const temperature = readNumber(settings.promptVariables.temperature) ?? 0.4;
  const mcpItems = readIntegrationList(settings.mcpServers, defaultMcpItems(settings.mcpEnabled));
  const ragItems = readIntegrationList(settings.ragConfig.sources, defaultRagItems(settings.ragEnabled));

  function setTemperature(value: number) {
    setSettings({
      ...settings,
      promptVariables: {
        ...settings.promptVariables,
        temperature: value,
      },
    });
  }

  function setMcpItem(index: number, on: boolean) {
    const nextItems = mcpItems.map((item, itemIndex) => itemIndex === index ? { ...item, on } : item);
    setSettings({ ...settings, mcpEnabled: nextItems.some((item) => item.on), mcpServers: nextItems });
  }

  function setRagItem(index: number, on: boolean) {
    const nextItems = ragItems.map((item, itemIndex) => itemIndex === index ? { ...item, on } : item);
    setSettings({
      ...settings,
      ragEnabled: nextItems.some((item) => item.on),
      ragConfig: { ...settings.ragConfig, sources: nextItems },
    });
  }

  return (
    <div className="of-app-page">
      <AppTopBar label="" go={go} right={<div className="admin-pill"><Icon name="shield" size={14} /> Админ</div>} />
      <div className="of-container admin-page">
        <PageIntro title="Конфигурация движка">
          Модели, промпты и источники контекста. Изменения применяются к новым разборам.
        </PageIntro>

        <div className="admin-tabs">
          {(["models", "prompts", "memory", "mcp", "rag"] as AdminSubtab[]).map((tab) => (
            <button type="button" key={tab} className={adminTab === tab ? "active" : ""} onClick={() => setAdminTab(tab)}>
              {adminTabLabel(tab)}
            </button>
          ))}
        </div>

        {adminTab === "models" ? (
          <div className="admin-stack">
            <section className="of-card">
              <h2>LLM для анализа</h2>
              <p>Модель, которая строит разбор и ведёт диалог. Провайдера можно менять без правок остального кода.</p>
              <div className="pill-wrap">
                {LLM_OPTIONS.map((option) => {
                  const model = option.model || settings.llmModel;
                  const provider = option.model ? option.provider : settings.llmProvider;
                  const active = settings.llmProvider === provider && settings.llmModel === model;

                  return (
                    <button
                      type="button"
                      key={`${option.label}-${model}`}
                      className={active ? "pill active" : "pill"}
                      onClick={() => setSettings({ ...settings, llmProvider: provider, llmModel: model })}
                    >
                      {option.label === "Current model" ? settings.llmModel : option.label}
                    </button>
                  );
                })}
              </div>
              <label className="admin-input">
                <span>Custom model</span>
                <input value={settings.llmModel} onChange={(event) => setSettings({ ...settings, llmModel: event.target.value })} />
              </label>
              <div className="temperature-row">
                <div><span>Temperature</span><b>{temperature.toFixed(1)}</b></div>
                <input type="range" min="0" max="1.5" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} />
              </div>
            </section>
            <section className="of-card">
              <h2>STT — модель транскрибации</h2>
              <p>Speech-to-text для перевода записи в текст с таймкодами. В текущей интеграции используется AssemblyAI.</p>
              <div className="pill-wrap">
                {STT_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option}
                    className={settings.sttModel === option ? "pill active" : "pill"}
                    onClick={() => setSettings({ ...settings, sttModel: option })}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <label className="admin-input">
                <span>Custom STT model</span>
                <input value={settings.sttModel} onChange={(event) => setSettings({ ...settings, sttModel: event.target.value })} />
              </label>
            </section>
          </div>
        ) : null}

        {adminTab === "prompts" ? (
          <div className="admin-stack">
            <PromptEditor badge="system" title="Системный промпт" value={settings.systemPrompt} onChange={(systemPrompt) => setSettings({ ...settings, systemPrompt })} />
            <PromptEditor badge="user" title="Пользовательский промпт" value={settings.userPromptTemplate} onChange={(userPromptTemplate) => setSettings({ ...settings, userPromptTemplate })} />
            <PromptEditor badge="assistant" title="Затравка ассистента" value={settings.assistantPromptTemplate} onChange={(assistantPromptTemplate) => setSettings({ ...settings, assistantPromptTemplate })} />
          </div>
        ) : null}

        {adminTab === "memory" ? (
          <AdminMemoryTab
            selected={selected}
            interviews={interviews}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            profileMemory={profileMemory}
            knowledgeMemory={knowledgeMemory}
            profileStatement={profileStatement}
            setProfileStatement={setProfileStatement}
            rememberProfile={rememberProfile}
            candidateProfileMemory={candidateProfileMemory}
            knowledgeTitle={knowledgeTitle}
            setKnowledgeTitle={setKnowledgeTitle}
            knowledgeContent={knowledgeContent}
            setKnowledgeContent={setKnowledgeContent}
            addKnowledge={addKnowledge}
          />
        ) : null}

        {adminTab === "mcp" ? <IntegrationTab title="MCP-подключения" text="Внешние инструменты и хранилища через Model Context Protocol." items={mcpItems} onToggle={setMcpItem} /> : null}
        {adminTab === "rag" ? <IntegrationTab title="RAG-источники" text="Векторные базы знаний для подмешивания контекста: типичные ошибки, матрицы грейдов, банки вопросов." items={ragItems} onToggle={setRagItem} /> : null}

        <div className="admin-save">
          <button className="of-primary" type="button" onClick={() => deferAsync(saveSettings)}>Сохранить настройки</button>
        </div>
      </div>
    </div>
  );
}

function AdminMemoryTab({
  selected,
  interviews,
  selectedId,
  setSelectedId,
  profileMemory,
  knowledgeMemory,
  profileStatement,
  setProfileStatement,
  rememberProfile,
  candidateProfileMemory,
  knowledgeTitle,
  setKnowledgeTitle,
  knowledgeContent,
  setKnowledgeContent,
  addKnowledge,
}: {
  selected: Interview | null;
  interviews: Interview[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  profileMemory: MemoryItem[];
  knowledgeMemory: MemoryItem[];
  profileStatement: string;
  setProfileStatement: (value: string) => void;
  rememberProfile: (statement?: string) => Promise<void>;
  candidateProfileMemory: unknown[];
  knowledgeTitle: string;
  setKnowledgeTitle: (value: string) => void;
  knowledgeContent: string;
  setKnowledgeContent: (value: string) => void;
  addKnowledge: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const workingItems = (selected?.messages ?? []).slice(-4).map((message) => `${message.role}: ${message.content}`);
  const taskItems = objectEntries(selected?.taskMemory ?? {}).slice(0, 6).map(([key, value]) => `${key}: ${stringifyShort(value)}`);

  return (
    <div className="admin-stack">
      <section className="user-selector">
        <div className="of-overline">Пользователь</div>
        <div className="recent-list">
          {interviews.slice(0, 5).map((interview) => (
            <button
              type="button"
              key={interview.id}
              className={selectedId === interview.id ? "recent-item active" : "recent-item"}
              onClick={() => setSelectedId(interview.id)}
            >
              <span className="avatar">{initials(interview.company || "OF")}</span>
              <span><strong>{interview.company || "Без компании"}</strong><small>{interview.position || "роль"} · {interview.targetLevel || "уровень"}</small></span>
            </button>
          ))}
          {interviews.length === 0 ? <p>Разборов пока нет.</p> : null}
        </div>
      </section>

      <div className="admin-memory-grid">
        <div className="admin-stack">
          <MemoryAdminCard title="Профиль кандидата" overline="долговременная память" dot="#09055a">
            <div className="memory-edit-list">
              {profileMemory.map((item) => <input key={item.id} readOnly value={item.statement ?? ""} />)}
              {profileMemory.length === 0 ? <p>Явно сохранённых фактов пока нет.</p> : null}
            </div>
            <div className="inline-add">
              <input value={profileStatement} onChange={(event) => setProfileStatement(event.target.value)} placeholder="Пользователь целится в Senior Android" />
              <button type="button" onClick={() => rememberProfile()}>Добавить факт</button>
            </div>
          </MemoryAdminCard>

          <MemoryAdminCard title="Кандидаты на профиль" overline="требуют явного подтверждения" dot="#6c7cf0">
            <div className="candidate-list">
              {candidateProfileMemory.map((candidate, index) => {
                const statement = isRecord(candidate) && typeof candidate.statement === "string" ? candidate.statement : JSON.stringify(candidate);
                return (
                  <div key={index}>
                    <span>{statement}</span>
                    <button type="button" onClick={() => rememberProfile(statement)}>Сохранить</button>
                  </div>
                );
              })}
              {candidateProfileMemory.length === 0 ? <p>Кандидатов пока нет.</p> : null}
            </div>
          </MemoryAdminCard>
        </div>

        <MemoryAdminCard title="Рабочая память" overline="краткосрочная · этот диалог" dot="#120b8f">
          <div className="memory-edit-list">
            {workingItems.map((item) => <input key={item} readOnly value={item} />)}
            {workingItems.length === 0 ? <p>Диалог пока пуст.</p> : null}
          </div>
          <div className="task-state-block">
            <div className="layer-subtitle"><span />Состояние задачи</div>
            <div className="memory-edit-list">
              {taskItems.map((item) => <input key={item} readOnly value={item} />)}
              {taskItems.length === 0 ? <p>Task memory появится после создания разбора.</p> : null}
            </div>
          </div>
        </MemoryAdminCard>
      </div>

      <section className="of-card knowledge-card">
        <div className="layer-title"><span style={{ background: "#1c1c23" }} />Общая база знаний</div>
        <div className="of-overline">долговременная · общая для всех пользователей</div>
        <p>Паттерны типичных ошибок. Изменения здесь сразу видны в инспекторе памяти диалога.</p>
        <div className="knowledge-grid">
          {knowledgeMemory.map((item) => <input key={item.id} readOnly value={`${item.title ?? ""}: ${item.content ?? ""}`} />)}
          {knowledgeMemory.length === 0 ? <p>Knowledge memory пока пустая.</p> : null}
        </div>
        <form className="knowledge-form" onSubmit={addKnowledge}>
          <input value={knowledgeTitle} onChange={(event) => setKnowledgeTitle(event.target.value)} placeholder="Android Middle+: Flow cancellation" />
          <input value={knowledgeContent} onChange={(event) => setKnowledgeContent(event.target.value)} placeholder="Обобщенное знание продукта" />
          <button type="submit">Добавить паттерн в базу</button>
        </form>
      </section>
    </div>
  );
}

function AppTopBar({
  label,
  go,
  right,
  maxWidth = "1080",
}: {
  label: string;
  go: (screen: Screen) => void;
  right?: React.ReactNode;
  maxWidth?: "1080" | "1280";
}) {
  return (
    <header className="app-topbar">
      <div className={maxWidth === "1280" ? "app-topbar-inner wide" : "app-topbar-inner"}>
        <Logo onClick={() => go("landing")} />
        {right ?? <div className="topbar-label">{label}</div>}
      </div>
    </header>
  );
}

function Logo({ onClick, size = "normal" }: { onClick?: () => void; size?: "normal" | "large" }) {
  return (
    <button type="button" className={size === "large" ? "of-logo large" : "of-logo"} onClick={onClick} aria-label="OfferFactory.ai">
      <span><Icon name="bookmark" size={size === "large" ? 18 : 13} /></span>
      <strong>OfferFactory<b>.ai</b></strong>
    </button>
  );
}

function PageIntro({ title, compact, children }: { title: string; compact?: boolean; children: React.ReactNode }) {
  return (
    <div className={compact ? "page-intro compact" : "page-intro"}>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}

function MetricCard({ value, label, tone }: { value: string; label: string; tone?: "brand" }) {
  return (
    <div className={tone === "brand" ? "metric-card brand" : "metric-card"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StepCard({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="step-card">
      <span><Icon name={icon} size={22} /></span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field-label">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PillGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="pill-group">
      <div>{label}</div>
      <div className="pill-wrap">
        {options.map((option) => (
          <button type="button" key={option} className={value === option ? "pill active" : "pill"} onClick={() => onChange(option)}>
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function InsightCard({ icon, title, items, muted }: { icon: IconName; title: string; items: string[]; muted?: boolean }) {
  return (
    <section className="of-card insight-card">
      <div className="insight-head">
        <span className={muted ? "muted" : ""}><Icon name={icon} size={18} /></span>
        <h2>{title}</h2>
      </div>
      <div className={muted ? "bullet-list muted" : "bullet-list"}>
        {items.map((item) => (
          <div key={item}><span /> <p>{item}</p></div>
        ))}
      </div>
    </section>
  );
}

function MemoryLayerCard({
  layer,
  enabled,
  showGroup,
  onToggle,
}: {
  layer: MemoryLayerView;
  enabled: boolean;
  showGroup: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={enabled ? "layer-wrap" : "layer-wrap disabled"}>
      {showGroup ? <div className="layer-group">{layer.group}</div> : null}
      <div className="layer-card">
        <div className="layer-row">
          <span style={{ background: layer.dot }} />
          <div>
            <strong>{layer.title} <em>· {layer.items.length}</em></strong>
            <small>{layer.sub}</small>
          </div>
          <button type="button" className={enabled ? "switch on" : "switch"} onClick={onToggle} aria-label={`${layer.title}: prompt toggle`}>
            <span />
          </button>
        </div>
        <div className="layer-items">
          {(layer.items.length > 0 ? layer.items.slice(0, 4) : ["Пока нет данных в этом слое."]).map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function PromptEditor({ badge, title, value, onChange }: { badge: string; title: string; value: string; onChange: (value: string) => void }) {
  return (
    <section className="of-card prompt-editor">
      <div className="prompt-title"><span>{badge}</span><h2>{title}</h2></div>
      <p>Редактируется в admin settings и применяется к следующим LLM-запросам.</p>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </section>
  );
}

function MemoryAdminCard({
  title,
  overline,
  dot,
  children,
}: {
  title: string;
  overline: string;
  dot: string;
  children: React.ReactNode;
}) {
  return (
    <section className="of-card memory-admin-card">
      <div className="layer-title"><span style={{ background: dot }} />{title}</div>
      <div className="of-overline">{overline}</div>
      {children}
    </section>
  );
}

function IntegrationTab({
  title,
  text,
  items,
  onToggle,
}: {
  title: string;
  text: string;
  items: IntegrationItem[];
  onToggle: (index: number, on: boolean) => void;
}) {
  return (
    <section className="of-card integration-card">
      <h2>{title}</h2>
      <p>{text}</p>
      <div className="integration-list">
        {items.map((item, index) => (
          <div key={item.name} className="integration-row">
            <span><Icon name={title.startsWith("MCP") ? "link" : "database"} size={18} /></span>
            <div>
              <strong>{item.name}</strong>
              <small>{item.desc}</small>
            </div>
            <button type="button" className={item.on ? "switch on" : "switch"} onClick={() => onToggle(index, !item.on)}>
              <span />
            </button>
          </div>
        ))}
        <div className="dashed-add"><Icon name="plus" size={16} /> {title.startsWith("MCP") ? "Добавить MCP-сервер" : "Подключить источник"}</div>
      </div>
    </section>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty-state">
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return <div><div className="json-title">{title}</div><pre className="jsonBlock">{JSON.stringify(value, null, 2)}</pre></div>;
}

type IconName = "upload" | "mic" | "edit" | "file" | "brain" | "bookmark" | "send" | "chat" | "check" | "alert" | "image" | "plus" | "shield" | "link" | "database";

function Icon({ name, size }: { name: IconName; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  const paths: Record<IconName, React.ReactNode> = {
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    mic: <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></>,
    brain: <><path d="M12 2a4 4 0 0 0-4 4 4 4 0 0 0-2 7 4 4 0 0 0 4 7 3 3 0 0 0 2-1 3 3 0 0 0 2 1 4 4 0 0 0 4-7 4 4 0 0 0-2-7 4 4 0 0 0-4-4z" /><path d="M12 5v14" /></>,
    bookmark: <path d="M5 3v18l7-5 7 5V3z" />,
    send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
    chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    check: <polyline points="20 6 9 17 4 12" />,
    alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.5-3.5L9 20" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

function deriveFeedbackView(selected: Interview | null): FeedbackView {
  const output = selected?.llmOutput ?? {};
  const taskMemory = selected?.taskMemory ?? {};
  const score = readNumber(output.score);
  const fallbackScore = selected?.status === "analyzed" ? 6.4 : null;
  const resolvedScore = score ?? fallbackScore;
  const summary = readString(output.summary) || readString(taskMemory.finalFeedback) || "После анализа здесь появится краткое резюме: что получилось, где ответ был неполным и какие темы подтянуть.";

  return {
    score: resolvedScore,
    scoreCaption: resolvedScore === null ? "анализ не запущен" : `из 10 · ${scoreCaption(resolvedScore)}`,
    summary,
    competencies: readCompetencies(output.competencies, resolvedScore),
    strengths: readInsightList(output.strengths ?? taskMemory.strengths, [
      "Контекст интервью сохранён отдельно в task memory.",
      "После анализа сильные стороны будут связаны с конкретными доказательствами из транскрипта.",
      "Profile memory не записывается автоматически без явного подтверждения.",
    ]),
    weaknesses: readInsightList(output.weaknesses ?? taskMemory.weaknesses, [
      "Запусти LLM-анализ, чтобы получить реальные слабые места по ответам.",
      "Если есть только ссылка на запись, сначала проверь, что AssemblyAI может скачать файл.",
      "Короткий chat после анализа покажет, как working memory отделена от profile memory.",
    ]),
    moments: readMoments(output.timeline, selected),
    recommendations: readRecommendations(output, [
      "Запусти транскрибацию и короткий LLM-анализ на mini-модели.",
      "После анализа задай ассистенту один уточняющий вопрос по самому слабому месту.",
      "Сохраняй profile memory только через явное действие в админке или предложении ассистента.",
    ]),
  };
}

function readCompetencies(value: unknown, score: number | null): CompetencyView[] {
  const base = [
    "Технические знания",
    "Системный дизайн",
    "Алгоритмы и структуры данных",
    "Коммуникация и мышление вслух",
    "Поведение и культура",
  ];

  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 6).map((item, index) => {
      const record = isRecord(item) ? item : {};
      const itemScore = readNumber(record.score ?? record.value ?? record.rating) ?? score ?? 5 + index * 0.2;
      return {
        name: readString(record.name ?? record.topic ?? record.title) || base[index] || `Компетенция ${index + 1}`,
        score: itemScore,
        color: scoreColor(itemScore),
      };
    });
  }

  const root = score ?? 0;
  const fallback = root > 0 ? [root + 0.4, root - 0.8, root, root - 0.4, root + 0.8] : [0, 0, 0, 0, 0];
  return base.map((name, index) => {
    const itemScore = Math.min(10, Math.max(0, fallback[index] ?? 0));
    return { name, score: itemScore, color: scoreColor(itemScore) };
  });
}

function readInsightList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }

  return value.slice(0, 5).map((item) => {
    if (typeof item === "string") {
      return item;
    }

    if (!isRecord(item)) {
      return JSON.stringify(item);
    }

    const topic = readString(item.topic ?? item.title ?? item.name);
    const evidence = readString(item.evidence ?? item.feedback ?? item.text ?? item.reason);
    const plan = readString(item.trainingPlan ?? item.recommendation);
    return [topic, evidence, plan].filter(Boolean).join(" — ");
  });
}

function readMoments(value: unknown, selected: Interview | null): MomentView[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.slice(0, 6).map((item, index) => {
      const record = isRecord(item) ? item : {};
      const tag = readString(record.event ?? record.tag ?? record.type) || (index === 0 ? "Сильно" : "Момент");
      return {
        time: readString(record.time ?? record.timestamp) || `${String(index * 7 + 1).padStart(2, "0")}:00`,
        tag,
        tagTone: /сильно|good|ok/i.test(tag) ? "brand" : "muted",
        text: readString(record.feedback ?? record.text ?? record.summary) || JSON.stringify(item),
      };
    });
  }

  if (selected?.transcript) {
    return [
      { time: "00:00", tag: "Транскрипт", tagTone: "brand", text: "Расшифровка загружена. Запусти LLM-анализ, чтобы получить таймкоды ошибок и сильных ответов." },
      { time: "--:--", tag: "Ожидает", tagTone: "muted", text: "Timeline появится после structured JSON output от модели." },
    ];
  }

  return [
    { time: "--:--", tag: "Ожидает", tagTone: "muted", text: "Ключевые моменты появятся после транскрибации и анализа записи." },
  ];
}

function readRecommendations(output: Record<string, unknown>, fallback: string[]) {
  const gaps = output.knowledgeGaps;
  if (Array.isArray(gaps) && gaps.length > 0) {
    return gaps.slice(0, 5).map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (!isRecord(item)) {
        return JSON.stringify(item);
      }

      return [readString(item.topic), readString(item.recommendation)].filter(Boolean).join(" — ");
    });
  }

  const weaknesses = output.weaknesses;
  if (Array.isArray(weaknesses)) {
    const plans = weaknesses
      .map((item) => (isRecord(item) ? readString(item.trainingPlan ?? item.recommendation) : ""))
      .filter(Boolean);
    if (plans.length > 0) {
      return plans;
    }
  }

  return fallback;
}

function deriveMemoryLayers(selected: Interview | null, profileMemory: MemoryItem[], knowledgeMemory: MemoryItem[]): MemoryLayerView[] {
  const working = (selected?.messages ?? []).slice(-6).map((message) => `${message.role === "user" ? "Кандидат" : "Ассистент"}: ${message.content}`);
  const task = objectEntries(selected?.taskMemory ?? {}).map(([key, value]) => `${key}: ${stringifyShort(value)}`);
  const profile = profileMemory.map((item) => item.statement ?? "").filter(Boolean);
  const knowledge = knowledgeMemory.map((item) => [item.title, item.content].filter(Boolean).join(" — ")).filter(Boolean);

  return [
    { key: "working", group: "Краткосрочная память", title: "Рабочая память", sub: "текущий диалог", dot: "#120b8f", items: working },
    { key: "task", group: "Краткосрочная память", title: "Состояние задачи", sub: "данные по разбору", dot: "#2d49e0", items: task },
    { key: "profile", group: "Долговременная память", title: "Профиль кандидата", sub: "явно сохранённые факты", dot: "#09055a", items: profile },
    { key: "knowledge", group: "Долговременная память", title: "База знаний", sub: "паттерны ошибок", dot: "#1c1c23", items: knowledge },
  ];
}

function buildPromptPreview(layers: MemoryLayerView[], enabled: Record<LayerKey, boolean>) {
  const parts = [
    "# SYSTEM",
    "Ты — наставник по IT-собеседованиям. Используй слои памяти строго отдельно.",
  ];

  for (const layer of layers) {
    parts.push("");
    if (!enabled[layer.key]) {
      parts.push(`## ${layer.title} (слой выключен в инспекторе)`);
      continue;
    }

    parts.push(`## ${layer.title}`);
    parts.push(...(layer.items.length > 0 ? layer.items.map((item) => `- ${item}`) : ["- нет данных"]));
  }

  return parts.join("\n");
}

function defaultMcpItems(enabled: boolean): IntegrationItem[] {
  return [
    { name: "Filesystem — профили кандидатов", desc: "чтение/запись markdown-профилей и состояния задач", on: enabled },
    { name: "Postgres — история разборов", desc: "выборка прошлых интервью и оценок", on: enabled },
    { name: "HR ATS", desc: "подтягивать вакансию и требования компании", on: false },
  ];
}

function defaultRagItems(enabled: boolean): IntegrationItem[] {
  return [
    { name: "База типичных ошибок Android", desc: "coroutines, Compose, KMP — pgvector-ready", on: enabled },
    { name: "Грейды и компетенции", desc: "матрица ожиданий по уровням", on: enabled },
    { name: "Вопросы прошлых интервью компаний", desc: "банк вопросов и паттернов", on: false },
  ];
}

function readIntegrationList(value: unknown, fallback: IntegrationItem[]) {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      return fallback[index] ?? { name: String(item), desc: "JSONB config item", on: false };
    }

    return {
      name: readString(item.name ?? item.title) || fallback[index]?.name || `Источник ${index + 1}`,
      desc: readString(item.desc ?? item.description) || fallback[index]?.desc || "JSONB config item",
      on: typeof item.on === "boolean" ? item.on : typeof item.enabled === "boolean" ? item.enabled : Boolean(fallback[index]?.on),
    };
  });
}

function adminTabLabel(tab: AdminSubtab) {
  return {
    models: "Модели",
    prompts: "Промпты",
    memory: "Память",
    mcp: "MCP",
    rag: "RAG",
  }[tab];
}

function scoreCaption(score: number) {
  if (score >= 8) {
    return "уверенный уровень";
  }
  if (score >= 6) {
    return "близко к целевому";
  }
  if (score > 0) {
    return "нужна подготовка";
  }
  return "анализ не запущен";
}

function scoreColor(score: number) {
  if (score >= 7.5) {
    return "#120b8f";
  }
  if (score >= 6) {
    return "#2d49e0";
  }
  return "#6b6b76";
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${Math.round(size / 1024 / 1024)} MB`;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "OF";
}

function objectEntries(value: Record<string, unknown>) {
  return Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "");
}

function stringifyShort(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<T>;
}

async function apiPost<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<T>;
}

async function apiPut<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return response.json() as Promise<T>;
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deferAsync(work: () => Promise<void>) {
  void Promise.resolve().then(work);
}
