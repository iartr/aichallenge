"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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
  errorMessage: string;
  assets?: Asset[];
  messages?: ChatMessage[];
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
};

type Tab = "upload" | "analysis" | "chat" | "memory" | "admin";

const LEVELS = ["junior", "middle", "middle+", "senior", "tech lead", "team lead"];
const TYPES = ["HR screening", "technical", "system design", "final", "soft skills", "live coding"];
const POSITIONS = ["Android", "iOS", "Frontend", "Backend", "QA", "GameDev", "DevOps", "Data", "ML", "Product"];

export function InterviewAssistantApp() {
  const [isAuthed, setIsAuthed] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [tab, setTab] = useState<Tab>("upload");
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
  const [form, setForm] = useState({ company: "", position: "Android", targetLevel: "middle+", interviewType: "technical", sourceUrl: "" });
  const [transcriptId, setTranscriptId] = useState("");
  const [chatText, setChatText] = useState("Как здесь можно было ответить сильнее?");
  const [profileStatement, setProfileStatement] = useState("");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");

  const candidateProfileMemory = useMemo(() => {
    const candidates = selected?.llmOutput?.candidateProfileMemory;
    return Array.isArray(candidates) ? candidates : [];
  }, [selected]);

  useEffect(() => {
    void checkSession();
  }, []);

  useEffect(() => {
    if (isAuthed) void bootstrap();
  }, [isAuthed]);

  useEffect(() => {
    if (selectedId) void loadInterview(selectedId);
  }, [selectedId]);

  async function checkSession() {
    const response = await fetch("/api/auth/session");
    setIsAuthed(response.ok);
  }

  async function bootstrap() {
    await Promise.all([loadInterviews(), loadSettings(), loadMemory()]);
  }

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
  }

  async function loadInterviews() {
    const data = await apiGet<{ interviews: Interview[] }>("/api/interviews");
    setInterviews(data.interviews);
    if (!selectedId && data.interviews[0]) setSelectedId(data.interviews[0].id);
  }

  async function loadInterview(id: string) {
    const data = await apiGet<{ interview: Interview }>(`/api/interviews/${id}`);
    setSelected(data.interview);
  }

  async function loadSettings() {
    const data = await apiGet<{ settings: Settings }>("/api/admin/settings");
    setSettings(data.settings);
  }

  async function loadMemory() {
    const [profile, knowledge] = await Promise.all([
      apiGet<{ items: MemoryItem[] }>("/api/memory/profile"),
      apiGet<{ items: MemoryItem[] }>("/api/memory/knowledge"),
    ]);
    setProfileMemory(profile.items);
    setKnowledgeMemory(knowledge.items);
  }

  async function createInterviewFlow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Создаю разбор");
    setError("");
    try {
      const data = await apiPost<{ interview: Interview }>("/api/interviews", { ...form, sourceType: form.sourceUrl ? "url" : "upload" });
      const interviewId = data.interview.id;
      if (recordingFile) await uploadFile(interviewId, "recording", recordingFile);
      for (const file of screenshotFiles.slice(0, 10)) await uploadFile(interviewId, "screenshot", file);
      setSelectedId(interviewId);
      await Promise.all([loadInterviews(), loadInterview(interviewId)]);
      setTab("analysis");
      setStatus("Разбор создан");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ошибка создания разбора");
      setStatus("Ошибка");
    }
  }

  async function uploadFile(interviewId: string, kind: "recording" | "screenshot", file: File) {
    const { asset, upload } = await apiPost<{ asset: Asset; upload: { url: string; headers: Record<string, string> } }>(`/api/interviews/${interviewId}/actions`, {
      action: "presign_upload",
      kind,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
    const uploadResponse = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: file });
    if (!uploadResponse.ok) throw new Error(`S3 upload failed for ${file.name}.`);
    await apiPost(`/api/interviews/${interviewId}/actions`, { action: "mark_uploaded", assetId: asset.id });
  }

  async function action(actionName: string, payload: Record<string, unknown> = {}) {
    if (!selectedId) return;
    setStatus(actionName);
    setError("");
    try {
      const data = await apiPost<Record<string, unknown>>(`/api/interviews/${selectedId}/actions`, { action: actionName, ...payload });
      if (actionName === "transcribe" && isRecord(data.transcript) && typeof data.transcript.id === "string") setTranscriptId(data.transcript.id);
      await Promise.all([loadInterviews(), loadInterview(selectedId), loadMemory()]);
      setStatus("Готово");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
      setStatus("Ошибка");
    }
  }

  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatText.trim()) return;
    const message = chatText;
    setChatText("");
    await action("chat", { message });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
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
    if (!statement.trim()) return;
    await apiPost("/api/memory/profile", { statement, confirm: true, source: "explicit_user_action", interviewId: selectedId || undefined });
    setProfileStatement("");
    await loadMemory();
  }

  async function addKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!knowledgeTitle.trim() || !knowledgeContent.trim()) return;
    await apiPost("/api/memory/knowledge", { title: knowledgeTitle, content: knowledgeContent });
    setKnowledgeTitle("");
    setKnowledgeContent("");
    await loadMemory();
  }

  if (!isAuthed) {
    return (
      <main className="authScreen">
        <form className="loginCard" onSubmit={login}>
          <Logo />
          <h1>OfferFactory.ai</h1>
          <p>Прототип разбора IT-собеседований с раздельными слоями памяти.</p>
          <input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="ADMIN_PASSWORD" />
          <button type="submit">Войти</button>
          {error ? <div className="errorBox">{error}</div> : null}
        </form>
      </main>
    );
  }

  return (
    <main className="appShell">
      <header className="topNav"><Logo /><div className="statusPill">{status}</div></header>
      <section className="hero">
        <div><p className="eyebrow">SaaS Interview Feedback</p><h1>Разбор собеседования с управляемой памятью</h1><p>Загрузка записи, AssemblyAI транскрибация, LLM-анализ, post-analysis chat и инспекция memory layers.</p></div>
        <div className="heroCard"><span>Memory isolation</span><strong>working / task / profile / knowledge</strong><small>Profile memory пишется только явным подтверждением.</small></div>
      </section>
      {error ? <div className="errorBox">{error}</div> : null}
      <nav className="tabs">{(["upload", "analysis", "chat", "memory", "admin"] as Tab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabLabel(item)}</button>)}</nav>
      <div className="workspace">
        <aside className="sidebar panel"><div className="panelTitle">Разборы</div>{interviews.map((interview) => <button key={interview.id} className={`interviewItem ${selectedId === interview.id ? "active" : ""}`} onClick={() => setSelectedId(interview.id)}><strong>{interview.company || "Без компании"}</strong><span>{interview.position} · {interview.targetLevel}</span><small>{interview.status}</small></button>)}</aside>
        <section className="mainPanel">
          {tab === "upload" ? <UploadPanel form={form} setForm={setForm} onSubmit={createInterviewFlow} recordingFile={recordingFile} setRecordingFile={setRecordingFile} setScreenshotFiles={setScreenshotFiles} /> : null}
          {tab === "analysis" ? <AnalysisPanel selected={selected} transcriptId={transcriptId} setTranscriptId={setTranscriptId} action={action} /> : null}
          {tab === "chat" ? <ChatPanel selected={selected} chatText={chatText} setChatText={setChatText} sendChat={sendChat} /> : null}
          {tab === "memory" ? <MemoryPanel selected={selected} profileMemory={profileMemory} knowledgeMemory={knowledgeMemory} profileStatement={profileStatement} setProfileStatement={setProfileStatement} rememberProfile={rememberProfile} candidateProfileMemory={candidateProfileMemory} knowledgeTitle={knowledgeTitle} setKnowledgeTitle={setKnowledgeTitle} knowledgeContent={knowledgeContent} setKnowledgeContent={setKnowledgeContent} addKnowledge={addKnowledge} /> : null}
          {tab === "admin" && settings ? <AdminPanel settings={settings} setSettings={setSettings} saveSettings={saveSettings} /> : null}
        </section>
      </div>
    </main>
  );
}

function UploadPanel(props: { form: { company: string; position: string; targetLevel: string; interviewType: string; sourceUrl: string }; setForm: (value: { company: string; position: string; targetLevel: string; interviewType: string; sourceUrl: string }) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; recordingFile: File | null; setRecordingFile: (file: File | null) => void; setScreenshotFiles: (files: File[]) => void }) {
  const { form, setForm, onSubmit, recordingFile, setRecordingFile, setScreenshotFiles } = props;
  return <form className="panel formGrid" onSubmit={onSubmit}><div><div className="panelTitle">Новое интервью</div><p className="muted">Файл записи до 2 GB, ссылка на Google Drive/Yandex Disk или до 10 скриншотов задач.</p></div><label>Компания<input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Avito, Ozon, JetBrains" /></label><div className="twoCols"><label>Роль<select value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}>{POSITIONS.map((item) => <option key={item}>{item}</option>)}</select></label><label>Уровень<select value={form.targetLevel} onChange={(e) => setForm({ ...form, targetLevel: e.target.value })}>{LEVELS.map((item) => <option key={item}>{item}</option>)}</select></label></div><label>Тип интервью<select value={form.interviewType} onChange={(e) => setForm({ ...form, interviewType: e.target.value })}>{TYPES.map((item) => <option key={item}>{item}</option>)}</select></label><label>Ссылка на запись<input value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} placeholder="https://drive.google.com/..." /></label><label>Файл записи<input type="file" accept="audio/*,video/*" onChange={(e) => setRecordingFile(e.target.files?.[0] ?? null)} /><span className="hint">{recordingFile ? `${recordingFile.name} · ${Math.round(recordingFile.size / 1024 / 1024)} MB` : "Можно оставить пустым, если указана ссылка."}</span></label><label>Скриншоты задач<input type="file" accept="image/*" multiple onChange={(e) => setScreenshotFiles(Array.from(e.target.files ?? []).slice(0, 10))} /></label><button className="primaryButton" type="submit">Создать разбор</button></form>;
}

function AnalysisPanel({ selected, transcriptId, setTranscriptId, action }: { selected: Interview | null; transcriptId: string; setTranscriptId: (value: string) => void; action: (actionName: string, payload?: Record<string, unknown>) => Promise<void> }) {
  if (!selected) return <EmptyPanel title="Выбери разбор" />;
  return <div className="panelStack"><section className="panel splitPanel"><div><div className="panelTitle">{selected.company || "Интервью"}</div><p className="muted">{selected.position} · {selected.targetLevel} · {selected.interviewType}</p><div className="metaGrid"><Metric label="Статус" value={selected.status} /><Metric label="Ассеты" value={String(selected.assets?.length ?? 0)} /><Metric label="Транскрипт" value={selected.transcript ? "есть" : "нет"} /></div></div><div className="actionsColumn"><button onClick={() => action("transcribe")}>Запустить AssemblyAI</button><div className="inlineAction"><input value={transcriptId} onChange={(e) => setTranscriptId(e.target.value)} placeholder="AssemblyAI transcript id" /><button onClick={() => action("transcribe", { transcriptId })}>Проверить</button></div><button className="primaryButton" onClick={() => action("analyze")}>Запустить LLM-анализ</button></div></section><section className="panel twoColsWide"><JsonBlock title="Task memory" value={selected.taskMemory} /><JsonBlock title="LLM output" value={selected.llmOutput} /></section><section className="panel"><div className="panelTitle">Транскрипт</div><pre className="textBlock">{selected.transcript || "Транскрипт появится после завершения AssemblyAI job."}</pre></section></div>;
}

function ChatPanel({ selected, chatText, setChatText, sendChat }: { selected: Interview | null; chatText: string; setChatText: (value: string) => void; sendChat: (event: FormEvent<HTMLFormElement>) => void }) {
  if (!selected) return <EmptyPanel title="Выбери разбор" />;
  return <section className="chatLayout"><div className="panel chatPanel"><div><div className="panelTitle">Диалог с ассистентом</div><p className="muted">Working memory = последние сообщения текущего чата. Task/profile/knowledge подмешиваются отдельными блоками.</p></div><div className="messages">{(selected.messages ?? []).map((message) => <div key={message.id} className={`message ${message.role}`}><strong>{message.role === "user" ? "Ты" : "Ассистент"}</strong><p>{message.content}</p></div>)}</div><form className="chatForm" onSubmit={sendChat}><textarea value={chatText} onChange={(e) => setChatText(e.target.value)} rows={3} /><button className="primaryButton" type="submit">Отправить</button></form></div><aside className="panel memoryInspector"><div className="panelTitle">Память</div><MemoryLayer title="Working memory" body={`${selected.messages?.length ?? 0} сообщений текущего диалога`} /><MemoryLayer title="Task memory" body={`${Object.keys(selected.taskMemory ?? {}).length} ключей по интервью`} /><MemoryLayer title="Profile memory" body="Только явно сохраненный профиль" /><MemoryLayer title="Knowledge memory" body="Обобщенная база знаний продукта" /></aside></section>;
}

function MemoryPanel(props: { selected: Interview | null; profileMemory: MemoryItem[]; knowledgeMemory: MemoryItem[]; profileStatement: string; setProfileStatement: (value: string) => void; rememberProfile: (statement?: string) => Promise<void>; candidateProfileMemory: unknown[]; knowledgeTitle: string; setKnowledgeTitle: (value: string) => void; knowledgeContent: string; setKnowledgeContent: (value: string) => void; addKnowledge: (event: FormEvent<HTMLFormElement>) => void }) {
  const { selected, profileMemory, knowledgeMemory, profileStatement, setProfileStatement, rememberProfile, candidateProfileMemory, knowledgeTitle, setKnowledgeTitle, knowledgeContent, setKnowledgeContent, addKnowledge } = props;
  return <div className="panelStack"><section className="panel twoColsWide"><div><div className="panelTitle">Profile memory</div><p className="muted">Долговременная память о пользователе. Запись только через явное действие.</p><div className="inlineAction"><input value={profileStatement} onChange={(e) => setProfileStatement(e.target.value)} placeholder="Пользователь целится в Senior Android" /><button onClick={() => rememberProfile()}>Запомнить</button></div><div className="list">{profileMemory.map((item) => <MemoryRow key={item.id} title={item.statement ?? ""} />)}</div></div><div><div className="panelTitle">Candidates, not saved</div><p className="muted">LLM может предложить profile memory, но сохранение требует подтверждения.</p><div className="list">{candidateProfileMemory.map((candidate, index) => { const statement = isRecord(candidate) && typeof candidate.statement === "string" ? candidate.statement : JSON.stringify(candidate); return <div className="candidate" key={index}><span>{statement}</span><button onClick={() => rememberProfile(statement)}>Сохранить явно</button></div>; })}{candidateProfileMemory.length === 0 ? <p className="muted">Кандидатов пока нет.</p> : null}</div></div></section><section className="panel twoColsWide"><form onSubmit={addKnowledge} className="formGrid compact"><div className="panelTitle">Knowledge memory</div><input value={knowledgeTitle} onChange={(e) => setKnowledgeTitle(e.target.value)} placeholder="Android Middle+: Flow cancellation" /><textarea value={knowledgeContent} onChange={(e) => setKnowledgeContent(e.target.value)} placeholder="Обобщенное знание продукта" rows={4} /><button type="submit">Добавить knowledge</button></form><div className="list">{knowledgeMemory.map((item) => <MemoryRow key={item.id} title={item.title ?? ""} body={item.content} />)}</div></section><section className="panel twoColsWide"><JsonBlock title="Task memory selected interview" value={selected?.taskMemory ?? {}} /><JsonBlock title="Layer check" value={{ working: "conversation_messages", task: "interviews.task_memory", profile: "profile_memory explicit writes only", knowledge: "knowledge_memory" }} /></section></div>;
}

function AdminPanel({ settings, setSettings, saveSettings }: { settings: Settings; setSettings: (value: Settings) => void; saveSettings: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="panelStack" onSubmit={saveSettings}><section className="panel formGrid"><div className="panelTitle">Конфигурация движка</div><div className="twoCols"><label>LLM provider<select value={settings.llmProvider} onChange={(e) => setSettings({ ...settings, llmProvider: e.target.value as Settings["llmProvider"] })}><option value="openai">OpenAI</option><option value="anthropic">Claude / Anthropic</option></select></label><label>LLM model<input value={settings.llmModel} onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })} /></label></div><label>AssemblyAI STT model<input value={settings.sttModel} onChange={(e) => setSettings({ ...settings, sttModel: e.target.value })} /></label></section><section className="panel formGrid"><div className="panelTitle">Промпты</div><label>System prompt<textarea rows={8} value={settings.systemPrompt} onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value })} /></label><label>User prompt template<textarea rows={10} value={settings.userPromptTemplate} onChange={(e) => setSettings({ ...settings, userPromptTemplate: e.target.value })} /></label><label>Assistant prefill<textarea rows={4} value={settings.assistantPromptTemplate} onChange={(e) => setSettings({ ...settings, assistantPromptTemplate: e.target.value })} /></label></section><section className="panel twoColsWide"><ToggleCard title="MCP expansion" checked={settings.mcpEnabled} onChange={(checked) => setSettings({ ...settings, mcpEnabled: checked })} body="Заготовка под список MCP servers в JSONB." /><ToggleCard title="RAG expansion" checked={settings.ragEnabled} onChange={(checked) => setSettings({ ...settings, ragEnabled: checked })} body="pgvector уже в схеме; embeddings и retrieval можно включить следующим шагом." /></section><button className="primaryButton" type="submit">Сохранить настройки</button></form>;
}

function Logo() { return <div className="logo"><span>⌑</span><strong>OfferFactory</strong><b>.ai</b></div>; }
function EmptyPanel({ title }: { title: string }) { return <section className="panel emptyPanel"><div className="panelTitle">{title}</div></section>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function JsonBlock({ title, value }: { title: string; value: unknown }) { return <div><div className="panelTitle small">{title}</div><pre className="jsonBlock">{JSON.stringify(value, null, 2)}</pre></div>; }
function MemoryLayer({ title, body }: { title: string; body: string }) { return <div className="memoryLayer"><strong>{title}</strong><span>{body}</span></div>; }
function MemoryRow({ title, body }: { title: string; body?: string }) { return <div className="memoryRow"><strong>{title}</strong>{body ? <span>{body}</span> : null}</div>; }
function ToggleCard({ title, body, checked, onChange }: { title: string; body: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="toggleCard"><span><strong>{title}</strong><small>{body}</small></span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>; }
function tabLabel(tab: Tab) { return { upload: "Загрузка", analysis: "Разбор", chat: "Диалог", memory: "Память", admin: "Админ" }[tab]; }

async function apiGet<T>(url: string): Promise<T> { const response = await fetch(url); if (!response.ok) throw new Error(await readError(response)); return response.json() as Promise<T>; }
async function apiPost<T = unknown>(url: string, body: unknown): Promise<T> { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await readError(response)); return response.json() as Promise<T>; }
async function apiPut<T>(url: string, body: unknown): Promise<T> { const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await readError(response)); return response.json() as Promise<T>; }
async function readError(response: Response) { try { const body = (await response.json()) as { error?: { message?: string } }; return body.error?.message ?? `Request failed with ${response.status}`; } catch { return `Request failed with ${response.status}`; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
