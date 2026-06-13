"use client";

import { FormEvent, Fragment, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type ChatRole = "user" | "assistant";

type StoredChatMessage = {
  role: ChatRole;
  content: string;
  usage?: MessageTokenUsage;
};

type ChatMessage = StoredChatMessage & {
  id: string;
  status?: "streaming" | "done" | "error";
};

type AuthUser = {
  login: string;
};

type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type ConversationRecord = ConversationSummary & {
  messages: StoredChatMessage[];
  summary?: unknown;
  summaryCoveredCount?: unknown;
  contextStrategy?: unknown;
  facts?: unknown;
  branches?: unknown;
};

type ApiErrorResponse = {
  error?: {
    message?: unknown;
  };
  usage?: unknown;
};

type SessionResponse = ApiErrorResponse & {
  user?: AuthUser | null;
};

type LoginResponse = ApiErrorResponse & {
  user?: AuthUser;
};

type ConversationsResponse = ApiErrorResponse & {
  conversations?: ConversationSummary[];
};

type ConversationResponse = ApiErrorResponse & {
  conversation?: ConversationRecord;
};

type AgentChatResponse = ConversationResponse & {
  answer?: unknown;
  model?: unknown;
  usage?: unknown;
  compression?: unknown;
  strategy?: unknown;
};

type ContextStrategy = "full" | "sliding_window" | "facts" | "branching" | "summary";

type FactEntry = {
  key: string;
  value: string;
};

type BranchInfo = {
  id: string;
  name: string;
  messageCount: number;
};

type StrategyReport = {
  strategy: ContextStrategy;
  enabled: boolean;
  windowSize: number;
  sentMessageCount: number;
  droppedMessageCount: number;
  sentHistoryTokens: number;
  fullHistoryTokens: number;
  savedTokens: number;
  savedPercent: number;
  extraTokens: number;
  factsTokens: number;
  facts: FactEntry[];
  branch: { activeId: string; activeName: string; count: number } | null;
  error: string | null;
};

const STRATEGY_OPTIONS: { value: ContextStrategy; label: string }[] = [
  { value: "full", label: "Full history" },
  { value: "sliding_window", label: "Sliding window" },
  { value: "facts", label: "Sticky facts" },
  { value: "branching", label: "Branching" },
  { value: "summary", label: "Summary (day4)" },
];

const DEFAULT_WINDOW_SIZE = 6;

type TokenFailureMode = "preflight_context_overflow" | "provider_context_overflow" | "provider_error";

type TokenUsage = {
  currentRequestTokens: number;
  historyTokens: number;
  responseTokens: number;
  totalTokens: number;
  contextWindowTokens: number;
  remainingContextTokens: number;
  estimatedCostUsd: number;
  failureMode: TokenFailureMode | null;
  cachedInputTokens: number;
  reasoningTokens: number;
  isEstimate: boolean;
};

type MessageTokenUsage = TokenUsage & {
  tokens: number;
  savedTokens?: number;
};

type TokenTimelineRow = {
  turn: number;
  usage: MessageTokenUsage;
};

type CompressionInfo = {
  enabled: boolean;
  summary: string;
  summaryTokens: number;
  coveredMessageCount: number;
  sentMessageCount: number;
  sentHistoryTokens: number;
  fullHistoryTokens: number;
  savedTokens: number;
  savedPercent: number;
  summarizerTokens: number;
};

type SummaryInfo = {
  text: string;
  coveredCount: number;
  tokens: number | null;
};

const EMPTY_STATUS_TEXT = "Ready";

export function ChatApp() {
  const [authStatus, setAuthStatus] = useState<"checking" | "anonymous" | "authenticated">("checking");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [login, setLogin] = useState("admin");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "typing" | "error">("idle");
  const [statusText, setStatusText] = useState(EMPTY_STATUS_TEXT);
  const [model, setModel] = useState("");
  const [latestUsage, setLatestUsage] = useState<TokenUsage | null>(null);
  const [strategy, setStrategy] = useState<ContextStrategy>("full");
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW_SIZE);
  const [latestStrategyReport, setLatestStrategyReport] = useState<StrategyReport | null>(null);
  const [facts, setFacts] = useState<FactEntry[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [latestCompression, setLatestCompression] = useState<CompressionInfo | null>(null);
  const [activeSummary, setActiveSummary] = useState<SummaryInfo | null>(null);
  const runIdRef = useRef(0);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const canLogin = Boolean(login.trim()) && Boolean(password) && authStatus !== "checking";
  const canSend = authStatus === "authenticated" && Boolean(user) && Boolean(input.trim()) && status !== "loading" && status !== "typing";
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );
  const persistedUsage = useMemo(() => readLatestMessageUsage(messages), [messages]);
  const visibleUsage = latestUsage ?? persistedUsage;
  const tokenTimeline = useMemo(() => buildTokenTimeline(messages), [messages]);
  const comparisonRows = useMemo(
    () => buildComparisonRows(tokenTimeline, visibleUsage, latestCompression, latestStrategyReport),
    [tokenTimeline, visibleUsage, latestCompression, latestStrategyReport],
  );
  const contextFill = visibleUsage
    ? clampPercent((visibleUsage.totalTokens / Math.max(visibleUsage.contextWindowTokens, 1)) * 100)
    : 0;
  const summaryInfo: SummaryInfo | null = latestCompression?.summary
    ? {
        text: latestCompression.summary,
        coveredCount: latestCompression.coveredMessageCount,
        tokens: latestCompression.summaryTokens,
      }
    : activeSummary;
  const coveredCount = strategy === "summary" ? (summaryInfo?.coveredCount ?? 0) : 0;

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      setAuthStatus("checking");

      try {
        const response = await fetch("/api/auth/session");
        const data = (await response.json()) as SessionResponse;

        if (!response.ok) {
          throw new Error(readErrorMessage(data, response.status));
        }

        if (cancelled) {
          return;
        }

        if (data.user) {
          await loadConversations(true);

          if (cancelled) {
            return;
          }

          setUser(data.user);
          setAuthStatus("authenticated");
          return;
        }

        setUser(null);
        setAuthStatus("anonymous");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoginError(error instanceof Error ? error.message : "Session check failed.");
        setUser(null);
        setAuthStatus("anonymous");
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
    // Runs once to restore the HTTP-only auth session after page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chatBody = chatBodyRef.current;

    if (!chatBody) {
      return;
    }

    chatBody.scrollTop = chatBody.scrollHeight;
  }, [messages]);

  async function loginUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canLogin) {
      return;
    }

    setAuthStatus("checking");
    setLoginError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          login: login.trim(),
          password,
        }),
      });
      const data = (await response.json()) as LoginResponse;

      if (!response.ok || !data.user) {
        throw new Error(readErrorMessage(data, response.status));
      }

      setPassword("");
      await loadConversations(true);
      setUser(data.user);
      setAuthStatus("authenticated");
    } catch (error) {
      setUser(null);
      setAuthStatus("anonymous");
      setLoginError(error instanceof Error ? error.message : "Login failed.");
    }
  }

  async function logoutUser() {
    runIdRef.current += 1;
    await fetch("/api/auth/logout", {
      method: "POST",
    });
    setUser(null);
    setAuthStatus("anonymous");
    setConversations([]);
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setModel("");
    setLatestUsage(null);
    setLatestCompression(null);
    setActiveSummary(null);
    setStrategy("full");
    setLatestStrategyReport(null);
    setFacts([]);
    setBranches([]);
    setActiveBranchId(null);
    setStatus("idle");
    setStatusText(EMPTY_STATUS_TEXT);
  }

  async function loadConversations(selectFirst: boolean) {
    const response = await fetch("/api/conversations");
    const data = (await response.json()) as ConversationsResponse;

    if (!response.ok) {
      throw new Error(readErrorMessage(data, response.status));
    }

    const nextConversations = Array.isArray(data.conversations) ? data.conversations : [];
    setConversations(nextConversations);

    if (selectFirst && nextConversations[0]) {
      await loadConversation(nextConversations[0].id);
      return;
    }

    if (selectFirst) {
      startNewChat();
    }
  }

  async function loadConversation(id: string) {
    runIdRef.current += 1;
    setStatus("loading");
    setStatusText("Loading");

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      const data = (await response.json()) as ConversationResponse;

      if (!response.ok || !data.conversation) {
        throw new Error(readErrorMessage(data, response.status));
      }

      setActiveConversationId(data.conversation.id);
      setMessages(toChatMessages(data.conversation));
      setLatestUsage(null);
      setLatestCompression(null);
      setActiveSummary(readConversationSummary(data.conversation));
      setStrategy(readStrategy(data.conversation) ?? "full");
      setLatestStrategyReport(null);
      setFacts(readFacts(data.conversation));
      hydrateBranches(data.conversation, null);
      setInput("");
      setStatus("idle");
      setStatusText(EMPTY_STATUS_TEXT);
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "Load failed");
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!canSend) {
      return;
    }

    const content = input.trim();
    const userMessage = createMessage("user", content);
    const assistantMessage = createMessage("assistant", "", "streaming");
    const currentRun = runIdRef.current + 1;

    runIdRef.current = currentRun;
    setInput("");
    setMessages((currentMessages) => [...currentMessages, userMessage, assistantMessage]);
    setLatestUsage(null);
    setStatus("loading");
    setStatusText("Waiting");

    let returnedUsage: TokenUsage | null = null;

    try {
      const response = await fetch("/api/agent-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(activeConversationId ? { conversationId: activeConversationId } : {}),
          message: content,
          strategy,
          windowSize,
          // Back-compat for the day4 summary path the server still honors.
          compression: strategy === "summary",
        }),
      });
      const data = (await response.json()) as AgentChatResponse;
      returnedUsage = readTokenUsage(data.usage);

      if (returnedUsage) {
        setLatestUsage(returnedUsage);
      }

      if (!response.ok || !data.conversation) {
        throw new Error(readErrorMessage(data, response.status));
      }

      const answer = typeof data.answer === "string" ? data.answer : "";

      if (!answer) {
        throw new Error("Agent returned an empty answer.");
      }

      if (typeof data.model === "string") {
        setModel(data.model);
      }

      upsertConversation(data.conversation);
      setActiveConversationId(data.conversation.id);
      setStatus("typing");
      setStatusText("Typing");
      await typeAssistantAnswer(assistantMessage.id, answer, currentRun);

      if (runIdRef.current === currentRun) {
        // Apply strategy/compression state together with the canonical message
        // list, otherwise the summary divider can briefly split the optimistic turn.
        setMessages(toChatMessages(data.conversation));
        setLatestCompression(readCompressionInfo(data.compression));
        setActiveSummary(readConversationSummary(data.conversation));
        const report = readStrategyReport(data.strategy);
        setLatestStrategyReport(report);
        setFacts(report?.facts.length ? report.facts : readFacts(data.conversation));
        hydrateBranches(data.conversation, report);
        setStatus("idle");
        setStatusText(EMPTY_STATUS_TEXT);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";

      if (runIdRef.current !== currentRun) {
        return;
      }

      if (returnedUsage) {
        setLatestUsage(returnedUsage);
      }

      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === assistantMessage.id
            ? {
                ...currentMessage,
                content: message,
                status: "error",
              }
            : currentMessage,
        ),
      );
      setStatus("error");
      setStatusText("Error");
    }
  }

  async function typeAssistantAnswer(messageId: string, answer: string, currentRun: number) {
    for (let index = 1; index <= answer.length; index += 1) {
      if (runIdRef.current !== currentRun) {
        return;
      }

      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === messageId
            ? {
                ...currentMessage,
                content: answer.slice(0, index),
                status: index === answer.length ? "done" : "streaming",
              }
            : currentMessage,
        ),
      );
      await delay(8);
    }
  }

  function startNewChat() {
    runIdRef.current += 1;
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setStatus("idle");
    setStatusText(EMPTY_STATUS_TEXT);
    setModel("");
    setLatestUsage(null);
    setLatestCompression(null);
    setActiveSummary(null);
    // Keep the chosen strategy/windowSize so a new chat inherits the current mode.
    setLatestStrategyReport(null);
    setFacts([]);
    setBranches([]);
    setActiveBranchId(null);
  }

  function upsertConversation(conversation: ConversationRecord) {
    const summary = toSummary(conversation);

    setConversations((currentConversations) => [
      summary,
      ...currentConversations.filter((currentConversation) => currentConversation.id !== summary.id),
    ]);
  }

  function hydrateBranches(conversation: ConversationRecord, report: StrategyReport | null) {
    const { branches: nextBranches, activeBranchId: nextActive } = readBranches(conversation);
    setBranches(nextBranches);
    setActiveBranchId(report?.branch?.activeId ?? nextActive);
  }

  async function callBranch(action: "set_checkpoint" | "fork" | "switch", extra?: Record<string, unknown>) {
    if (!activeConversationId) {
      return;
    }

    runIdRef.current += 1; // cancel any in-flight typing so a stale answer can't overwrite the switch
    setStatus("loading");
    setStatusText(action === "switch" ? "Switching" : action === "fork" ? "Forking" : "Checkpoint");

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await response.json()) as ConversationResponse;

      if (!response.ok || !data.conversation) {
        throw new Error(readErrorMessage(data, response.status));
      }

      setMessages(toChatMessages(data.conversation));
      upsertConversation(data.conversation);
      setActiveConversationId(data.conversation.id);
      setFacts(readFacts(data.conversation));
      hydrateBranches(data.conversation, null);
      setLatestStrategyReport(null);
      setLatestUsage(null);
      setStatus("idle");
      setStatusText(EMPTY_STATUS_TEXT);
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "Branch action failed");
    }
  }

  function checkpointBranch() {
    void callBranch("set_checkpoint", { index: messages.length });
  }

  function createBranch() {
    void callBranch("fork");
  }

  function selectBranch(branchId: string) {
    if (branchId === activeBranchId) {
      return;
    }

    void callBranch("switch", { branchId });
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void submit();
  }

  if (authStatus !== "authenticated" || !user) {
    return (
      <main className="chatShell">
        <section className="loginPanel" aria-label="Admin login">
          <header className="loginHeader">
            <p className="chatEyebrow">Week2 / Day4</p>
            <h1>Persistent Agent</h1>
          </header>
          <form className="loginForm" onSubmit={loginUser}>
            <label className="authField">
              <span>Login</span>
              <input
                value={login}
                autoComplete="username"
                disabled={authStatus === "checking"}
                onChange={(event) => setLogin(event.target.value)}
              />
            </label>
            <label className="authField">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                disabled={authStatus === "checking"}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {loginError ? (
              <div className="authError" role="alert">
                {loginError}
              </div>
            ) : null}
            <button className="sendButton" type="submit" disabled={!canLogin}>
              {authStatus === "checking" ? "Checking..." : "Log in"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="chatShell">
      <section className="chatPanel persistent" aria-label="AI chat agent">
        <aside className="conversationSidebar" aria-label="Dialog history">
          <div className="sidebarTop">
            <div>
              <p className="chatEyebrow">Week2 / Day5</p>
              <h1>Persistent Agent</h1>
            </div>
            <button className="iconButton" type="button" onClick={startNewChat} title="New chat" aria-label="New chat">
              +
            </button>
          </div>

          <nav className="conversationList" aria-label="Saved dialogs">
            {conversations.map((conversation) => (
              <button
                className={`conversationItem ${conversation.id === activeConversationId ? "active" : ""}`}
                type="button"
                key={conversation.id}
                title={conversation.title}
                onClick={() => void loadConversation(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small>{formatUpdatedAt(conversation.updatedAt)}</small>
              </button>
            ))}
          </nav>

          <div className="sidebarFooter">
            <span>{user.login}</span>
            <button className="secondaryButton compact" type="button" onClick={() => void logoutUser()}>
              Logout
            </button>
          </div>
        </aside>

        <section className="conversationPanel" aria-label="Active dialog">
          <header className="chatHeader compactHeader">
            <div>
              <p className="activeTitle" title={activeConversation?.title ?? "New chat"}>
                {activeConversation?.title ?? "New chat"}
              </p>
              <span>{messages.length ? `${messages.length} messages` : "No messages"}</span>
            </div>
            <div className={`agentStatus ${status}`} role="status" aria-live="polite">
              <span>{statusText}</span>
              {model ? <small>{model}</small> : null}
            </div>
          </header>

          <section className="tokenPanel" aria-label="Token accounting">
            <div className="tokenPanelHeader">
              <span className="tokenPanelTitle">Token usage</span>
              <label className="strategyField">
                <span className="srOnly">Context strategy</span>
                <select
                  className="strategySelect"
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value as ContextStrategy)}
                >
                  {STRATEGY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {strategy === "sliding_window" || strategy === "facts" ? (
              <div className="strategyControls">
                <label className="field compact">
                  <span>Last N messages</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={windowSize}
                    onChange={(event) => setWindowSize(clampWindow(Number(event.target.value)))}
                  />
                </label>
                <p className="strategyHint">
                  {strategy === "facts"
                    ? "Sends the facts block plus the last N messages."
                    : "Sends only the last N messages; older turns are dropped."}
                </p>
              </div>
            ) : null}

            {strategy === "branching" ? (
              <div className="strategyControls">
                <div className="branchBar" role="group" aria-label="Branches">
                  <div className="branchPills">
                    {branches.length ? (
                      branches.map((branch) => (
                        <button
                          key={branch.id}
                          type="button"
                          className={`branchPill ${branch.id === activeBranchId ? "active" : ""}`}
                          onClick={() => selectBranch(branch.id)}
                          title={`${branch.name} · ${branch.messageCount} msgs`}
                        >
                          {branch.name}
                        </button>
                      ))
                    ) : (
                      <span className="branchEmpty">No branches yet — send a message, then checkpoint</span>
                    )}
                  </div>
                  <div className="branchActions">
                    <button
                      type="button"
                      className="secondaryButton compact"
                      onClick={checkpointBranch}
                      disabled={!activeConversationId}
                    >
                      Checkpoint
                    </button>
                    <button
                      type="button"
                      className="secondaryButton compact"
                      onClick={createBranch}
                      disabled={!activeConversationId}
                    >
                      New branch
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="tokenDashboard">
              <div>
                <span>Prompt</span>
                <strong>{formatTokens(visibleUsage?.historyTokens ?? 0)}</strong>
                <small>+{formatTokens(visibleUsage?.currentRequestTokens ?? 0)} new</small>
              </div>
              <div>
                <span>Response</span>
                <strong>{formatTokens(visibleUsage?.responseTokens ?? 0)}</strong>
              </div>
              <div className="primary">
                <span>Total</span>
                <strong>{formatTokens(visibleUsage?.totalTokens ?? 0)}</strong>
              </div>
              <div>
                <span>Cost</span>
                <strong>{formatUsd(visibleUsage?.estimatedCostUsd ?? 0)}</strong>
              </div>
            </div>

            <div className="meterRow">
              <div className={`contextMeter ${visibleUsage?.failureMode ? "danger" : ""}`} aria-hidden="true">
                <span style={{ width: `${contextFill}%` }} />
              </div>
              <span className="meterLabel">
                {formatTokens(visibleUsage?.totalTokens ?? 0)} / {formatTokens(visibleUsage?.contextWindowTokens ?? 0)}{" "}
                window
              </span>
            </div>

            {strategy === "summary" ? (
              latestCompression?.enabled && latestCompression.coveredMessageCount > 0 ? (
                <div className="compressionStrip" role="status">
                  <span className="stat">
                    <span>Full history</span>
                    <strong>{formatTokens(latestCompression.fullHistoryTokens)}</strong>
                  </span>
                  <span className="stat">
                    <span>Sent</span>
                    <strong>{formatTokens(latestCompression.sentHistoryTokens)}</strong>
                  </span>
                  <span className="savedBadge">
                    Saved {formatTokens(latestCompression.savedTokens)} tok ({latestCompression.savedPercent.toFixed(0)}%)
                  </span>
                  <span className="stat muted">
                    <span>Summarizer</span>
                    <strong>+{formatTokens(latestCompression.summarizerTokens)}</strong>
                  </span>
                </div>
              ) : null
            ) : latestStrategyReport && latestStrategyReport.fullHistoryTokens > 0 ? (
              <div className="compressionStrip strategyStrip" role="status">
                <span className="stat">
                  <span>Full history</span>
                  <strong>{formatTokens(latestStrategyReport.fullHistoryTokens)}</strong>
                </span>
                <span className="stat">
                  <span>Sent</span>
                  <strong>{formatTokens(latestStrategyReport.sentHistoryTokens)}</strong>
                </span>
                {latestStrategyReport.savedTokens > 0 ? (
                  <span className="savedBadge">
                    Saved {formatTokens(latestStrategyReport.savedTokens)} tok (
                    {latestStrategyReport.savedPercent.toFixed(0)}%)
                  </span>
                ) : (
                  <span className="stat muted">
                    <span>Mode</span>
                    <strong>full send</strong>
                  </span>
                )}
                {latestStrategyReport.droppedMessageCount > 0 ? (
                  <span className="stat muted">
                    <span>Dropped</span>
                    <strong>{latestStrategyReport.droppedMessageCount} msgs</strong>
                  </span>
                ) : null}
                {latestStrategyReport.extraTokens > 0 ? (
                  <span className="stat muted">
                    <span>Facts block</span>
                    <strong>+{formatTokens(latestStrategyReport.extraTokens)}</strong>
                  </span>
                ) : null}
              </div>
            ) : null}

            <details className="tokenTablesDetails">
              <summary>Growth &amp; comparison tables</summary>
              <div className="tokenTables">
              <table>
                <caption>Growth</caption>
                <thead>
                  <tr>
                    <th>Turn</th>
                    <th>History</th>
                    <th>Answer</th>
                    <th>Total</th>
                    <th>Saved</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenTimeline.length ? (
                    tokenTimeline.map((row) => (
                      <tr key={row.turn}>
                        <td>{row.turn}</td>
                        <td>{formatTokens(row.usage.historyTokens)}</td>
                        <td>{formatTokens(row.usage.responseTokens)}</td>
                        <td>{formatTokens(row.usage.totalTokens)}</td>
                        <td>{row.usage.savedTokens !== undefined ? formatTokens(row.usage.savedTokens) : "—"}</td>
                        <td>{formatUsd(row.usage.estimatedCostUsd)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6}>No turns</td>
                    </tr>
                  )}
                </tbody>
              </table>

              <table>
                <caption>Comparison</caption>
                <thead>
                  <tr>
                    <th>Dialog</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Behavior</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((row) => (
                    <tr key={row.dialog}>
                      <td>{row.dialog}</td>
                      <td>{row.tokens}</td>
                      <td>{row.cost}</td>
                      <td>{row.behavior}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </details>

            {strategy === "facts" && facts.length ? (
              <details className="summaryDetails factsDetails" open>
                <summary>Sticky facts · {facts.length} keys</summary>
                <dl className="factsList">
                  {facts.map((fact) => (
                    <div className="factRow" key={fact.key}>
                      <dt>{fact.key}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}

            {strategy === "summary" && summaryInfo ? (
              <details className="summaryDetails">
                <summary>
                  Context summary · {summaryInfo.coveredCount} messages
                  {summaryInfo.tokens !== null ? ` · ${formatTokens(summaryInfo.tokens)} tok` : ""}
                </summary>
                <p className="summaryText">{summaryInfo.text}</p>
              </details>
            ) : null}
          </section>

          <div className="chatBody" aria-live="polite" ref={chatBodyRef}>
            {messages.length ? (
              messages.map((message, index) => (
                <Fragment key={message.id}>
                  <article
                    className={`message ${message.role} ${message.status ?? "done"} ${
                      index < coveredCount ? "inSummary" : ""
                    }`}
                  >
                    <div className="messageMeta">
                      <span>{message.role === "user" ? "You" : "Agent"}</span>
                      {message.usage ? <small>{formatTokens(message.usage.tokens)} tok</small> : null}
                    </div>
                    <div className="messageBubble">
                      {message.status === "streaming" && !message.content ? (
                        <span className="typingDots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        message.content
                      )}
                      {message.status === "streaming" && message.content ? (
                        <span className="caret" aria-hidden="true" />
                      ) : null}
                    </div>
                  </article>
                  {coveredCount > 0 && index === coveredCount - 1 && coveredCount < messages.length ? (
                    <div
                      className="compressionDivider"
                      role="separator"
                      aria-label={`${coveredCount} earlier messages compressed into summary`}
                    >
                      <span>{coveredCount} messages above folded into summary</span>
                    </div>
                  ) : null}
                </Fragment>
              ))
            ) : (
              <div className="emptyDialog">
                <strong>No messages yet</strong>
                <span>Type below and press Enter to send. Pick a context strategy above to control what history the agent sees.</span>
              </div>
            )}
          </div>

          <form className="composer" onSubmit={submit}>
            <label className="promptField">
              <span className="srOnly">Message</span>
              <textarea
                rows={3}
                value={input}
                placeholder="Message"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
              />
            </label>

            <div className="composerActions">
              <button className="secondaryButton" type="button" onClick={startNewChat}>
                New
              </button>
              <button className="sendButton" type="submit" disabled={!canSend}>
                {status === "loading" || status === "typing" ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}

function toChatMessages(conversation: ConversationRecord): ChatMessage[] {
  return conversation.messages.map((message, index) => ({
    id: `${conversation.id}-${index}`,
    role: message.role,
    content: message.content,
    usage: readMessageTokenUsage(message.usage),
    status: "done",
  }));
}

function createMessage(role: ChatRole, content: string, status: ChatMessage["status"] = "done"): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    status,
  };
}

function toSummary(conversation: ConversationRecord): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    messageCount: conversation.messageCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function readLatestMessageUsage(messages: ChatMessage[]): TokenUsage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index]?.usage;

    if (usage) {
      return usage;
    }
  }

  return null;
}

function buildTokenTimeline(messages: ChatMessage[]): TokenTimelineRow[] {
  let turn = 0;
  const rows: TokenTimelineRow[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage || message.status === "error") {
      continue;
    }

    turn += 1;
    rows.push({
      turn,
      usage: message.usage,
    });
  }

  return rows.slice(-6);
}

function buildComparisonRows(
  timeline: TokenTimelineRow[],
  usage: TokenUsage | null,
  compression: CompressionInfo | null,
  report: StrategyReport | null,
) {
  const shortDialog = timeline[0]?.usage ?? null;
  const longDialog = timeline.length > 1 ? timeline[timeline.length - 1]?.usage ?? null : null;
  const contextWindowTokens = usage?.contextWindowTokens ?? longDialog?.contextWindowTokens ?? shortDialog?.contextWindowTokens ?? 0;

  return [
    {
      dialog: "Short",
      tokens: shortDialog ? formatTokens(shortDialog.totalTokens) : "-",
      cost: shortDialog ? formatUsd(shortDialog.estimatedCostUsd) : "-",
      behavior: shortDialog ? "Fits" : "Pending",
    },
    {
      dialog: "Long",
      tokens: longDialog ? formatTokens(longDialog.totalTokens) : "-",
      cost: longDialog ? formatUsd(longDialog.estimatedCostUsd) : "-",
      behavior: longDialog ? "Costs more" : "Needs turns",
    },
    {
      dialog: report ? strategyLabel(report.strategy) : "Strategy",
      tokens: report ? formatTokens(report.sentHistoryTokens) : "-",
      cost: "-",
      behavior: report ? strategyBehavior(report) : "Pending",
    },
    {
      dialog: "Overflow",
      tokens: contextWindowTokens ? `>${formatTokens(contextWindowTokens)}` : "window + 1",
      cost: "-",
      behavior: usage?.failureMode ? "Blocked" : "413 guard",
    },
  ];
}

function strategyBehavior(report: StrategyReport): string {
  if (report.savedTokens > 0) {
    return `Saves ${report.savedPercent.toFixed(0)}%`;
  }

  if (report.droppedMessageCount > 0) {
    return `Drops ${report.droppedMessageCount}`;
  }

  if (report.extraTokens > 0) {
    return `+${formatTokens(report.extraTokens)} facts`;
  }

  return "Full send";
}

const CONTEXT_STRATEGY_VALUES: ContextStrategy[] = ["full", "sliding_window", "facts", "branching", "summary"];

function readStrategy(conversation: unknown): ContextStrategy | null {
  if (!isRecord(conversation)) {
    return null;
  }

  const value = conversation.contextStrategy;

  return typeof value === "string" && (CONTEXT_STRATEGY_VALUES as string[]).includes(value)
    ? (value as ContextStrategy)
    : null;
}

function readFacts(value: unknown): FactEntry[] {
  const source = isRecord(value) ? value.facts : value;
  const items = Array.isArray(source)
    ? source
    : isRecord(source) && Array.isArray(source.items)
      ? source.items
      : [];
  const facts: FactEntry[] = [];

  for (const entry of items) {
    if (isRecord(entry) && typeof entry.key === "string" && typeof entry.value === "string" && entry.value.trim()) {
      facts.push({ key: entry.key, value: entry.value });
    }
  }

  return facts;
}

function readBranches(conversation: unknown): { branches: BranchInfo[]; activeBranchId: string | null } {
  if (!isRecord(conversation) || !isRecord(conversation.branches)) {
    return { branches: [], activeBranchId: null };
  }

  const state = conversation.branches;
  const list = Array.isArray(state.list) ? state.list : [];
  const branches: BranchInfo[] = [];

  for (const entry of list) {
    if (isRecord(entry) && typeof entry.id === "string") {
      branches.push({
        id: entry.id,
        name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
        messageCount: Array.isArray(entry.messages) ? entry.messages.length : 0,
      });
    }
  }

  return {
    branches,
    activeBranchId: typeof state.activeBranchId === "string" ? state.activeBranchId : null,
  };
}

function readStrategyReport(value: unknown): StrategyReport | null {
  if (!isRecord(value) || typeof value.strategy !== "string") {
    return null;
  }

  const sentHistoryTokens = readNumber(value.sentHistoryTokens);
  const fullHistoryTokens = readNumber(value.fullHistoryTokens);
  const savedTokens = readNumber(value.savedTokens);
  const savedPercent = readNumber(value.savedPercent);

  if (
    sentHistoryTokens === undefined ||
    fullHistoryTokens === undefined ||
    savedTokens === undefined ||
    savedPercent === undefined
  ) {
    return null;
  }

  const branchValue = isRecord(value.branch) ? value.branch : null;

  return {
    strategy: (CONTEXT_STRATEGY_VALUES as string[]).includes(value.strategy)
      ? (value.strategy as ContextStrategy)
      : "full",
    enabled: value.enabled === true,
    windowSize: readNumber(value.windowSize) ?? DEFAULT_WINDOW_SIZE,
    sentMessageCount: readNumber(value.sentMessageCount) ?? 0,
    droppedMessageCount: readNumber(value.droppedMessageCount) ?? 0,
    sentHistoryTokens,
    fullHistoryTokens,
    savedTokens,
    savedPercent,
    extraTokens: readNumber(value.extraTokens) ?? 0,
    factsTokens: readNumber(value.factsTokens) ?? 0,
    facts: readFacts(value.facts),
    branch:
      branchValue && typeof branchValue.activeId === "string"
        ? {
            activeId: branchValue.activeId,
            activeName: typeof branchValue.activeName === "string" ? branchValue.activeName : branchValue.activeId,
            count: readNumber(branchValue.count) ?? 0,
          }
        : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function clampWindow(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_WINDOW_SIZE;
  }

  return Math.max(1, Math.min(50, Math.floor(value)));
}

function strategyLabel(strategy: ContextStrategy | undefined): string {
  return STRATEGY_OPTIONS.find((option) => option.value === strategy)?.label ?? "Strategy";
}

function readCompressionInfo(value: unknown): CompressionInfo | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return null;
  }

  const summaryTokens = readNumber(value.summaryTokens);
  const coveredMessageCount = readNumber(value.coveredMessageCount);
  const sentMessageCount = readNumber(value.sentMessageCount);
  const sentHistoryTokens = readNumber(value.sentHistoryTokens);
  const fullHistoryTokens = readNumber(value.fullHistoryTokens);
  const savedTokens = readNumber(value.savedTokens);
  const savedPercent = readNumber(value.savedPercent);

  if (
    sentHistoryTokens === undefined ||
    fullHistoryTokens === undefined ||
    savedTokens === undefined ||
    savedPercent === undefined
  ) {
    return null;
  }

  const summarizerTotal = isRecord(value.summarizer) ? readNumber(value.summarizer.totalTokens) : undefined;

  return {
    enabled: value.enabled,
    summary: typeof value.summary === "string" ? value.summary : "",
    summaryTokens: summaryTokens ?? 0,
    coveredMessageCount: coveredMessageCount ?? 0,
    sentMessageCount: sentMessageCount ?? 0,
    sentHistoryTokens,
    fullHistoryTokens,
    savedTokens,
    savedPercent,
    summarizerTokens: summarizerTotal ?? 0,
  };
}

function readConversationSummary(conversation: unknown): SummaryInfo | null {
  if (!isRecord(conversation)) {
    return null;
  }

  const text = typeof conversation.summary === "string" ? conversation.summary.trim() : "";
  const coveredCount = readNumber(conversation.summaryCoveredCount ?? conversation.summary_covered_count);

  if (!text || !coveredCount) {
    return null;
  }

  return {
    text,
    coveredCount,
    tokens: null,
  };
}

function readMessageTokenUsage(value: unknown): MessageTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage = readTokenUsage(value);
  const tokens = readNumber(value.tokens);

  if (!usage || tokens === undefined) {
    return undefined;
  }

  const savedTokens = readNumber(value.savedTokens);

  return {
    ...usage,
    tokens,
    ...(savedTokens !== undefined ? { savedTokens } : {}),
  };
}

function readTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const currentRequestTokens = readNumber(value.currentRequestTokens);
  const historyTokens = readNumber(value.historyTokens);
  const responseTokens = readNumber(value.responseTokens);
  const totalTokens = readNumber(value.totalTokens);
  const contextWindowTokens = readNumber(value.contextWindowTokens);
  const remainingContextTokens = readNumber(value.remainingContextTokens);
  const estimatedCostUsd = readNumber(value.estimatedCostUsd);

  if (
    currentRequestTokens === undefined ||
    historyTokens === undefined ||
    responseTokens === undefined ||
    totalTokens === undefined ||
    contextWindowTokens === undefined ||
    remainingContextTokens === undefined ||
    estimatedCostUsd === undefined
  ) {
    return null;
  }

  return {
    currentRequestTokens,
    historyTokens,
    responseTokens,
    totalTokens,
    contextWindowTokens,
    remainingContextTokens,
    estimatedCostUsd,
    failureMode: readFailureMode(value.failureMode),
    cachedInputTokens: readNumber(value.cachedInputTokens) ?? 0,
    reasoningTokens: readNumber(value.reasoningTokens) ?? 0,
    isEstimate: value.isEstimate === true,
  };
}

function readFailureMode(value: unknown): TokenFailureMode | null {
  if (value === "preflight_context_overflow" || value === "provider_context_overflow" || value === "provider_error") {
    return value;
  }

  return null;
}

function readNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);

  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function formatTokens(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function formatUsd(value: number) {
  if (value === 0) {
    return "$0.00";
  }

  if (value < 0.0001) {
    return "<$0.0001";
  }

  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }

  return `$${value.toFixed(2)}`;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function readErrorMessage(data: ApiErrorResponse, status: number) {
  if (typeof data.error?.message === "string" && data.error.message.trim()) {
    return data.error.message.trim();
  }

  return `Request failed with ${status}.`;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
