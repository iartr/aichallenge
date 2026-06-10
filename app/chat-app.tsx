"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

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
};

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
};

type TokenTimelineRow = {
  turn: number;
  usage: TokenUsage;
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
  const comparisonRows = useMemo(() => buildComparisonRows(tokenTimeline, visibleUsage), [tokenTimeline, visibleUsage]);
  const contextFill = visibleUsage
    ? clampPercent((visibleUsage.totalTokens / Math.max(visibleUsage.contextWindowTokens, 1)) * 100)
    : 0;

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
        setMessages(toChatMessages(data.conversation));
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
  }

  function upsertConversation(conversation: ConversationRecord) {
    const summary = toSummary(conversation);

    setConversations((currentConversations) => [
      summary,
      ...currentConversations.filter((currentConversation) => currentConversation.id !== summary.id),
    ]);
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
            <p className="chatEyebrow">Week2 / Day3</p>
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
              <p className="chatEyebrow">Week2 / Day3</p>
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
              <p className="activeTitle">{activeConversation?.title ?? "New chat"}</p>
              <span>{messages.length ? `${messages.length} messages` : "No messages"}</span>
            </div>
            <div className={`agentStatus ${status}`} role="status" aria-live="polite">
              <span>{statusText}</span>
              {model ? <small>{model}</small> : null}
            </div>
          </header>

          <section className="tokenPanel" aria-label="Token accounting">
            <div className="tokenDashboard">
              <div>
                <span>Request</span>
                <strong>{formatTokens(visibleUsage?.currentRequestTokens ?? 0)}</strong>
              </div>
              <div>
                <span>History</span>
                <strong>{formatTokens(visibleUsage?.historyTokens ?? 0)}</strong>
              </div>
              <div>
                <span>Response</span>
                <strong>{formatTokens(visibleUsage?.responseTokens ?? 0)}</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{formatTokens(visibleUsage?.totalTokens ?? 0)}</strong>
              </div>
              <div>
                <span>Window</span>
                <strong>{formatTokens(visibleUsage?.contextWindowTokens ?? 0)}</strong>
              </div>
              <div>
                <span>Cost</span>
                <strong>{formatUsd(visibleUsage?.estimatedCostUsd ?? 0)}</strong>
              </div>
            </div>

            <div className={`contextMeter ${visibleUsage?.failureMode ? "danger" : ""}`} aria-hidden="true">
              <span style={{ width: `${contextFill}%` }} />
            </div>

            <div className="tokenTables">
              <table>
                <caption>Growth</caption>
                <thead>
                  <tr>
                    <th>Turn</th>
                    <th>History</th>
                    <th>Answer</th>
                    <th>Total</th>
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
                        <td>{formatUsd(row.usage.estimatedCostUsd)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>No turns</td>
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
          </section>

          <div className="chatBody" aria-live="polite" ref={chatBodyRef}>
            {messages.length ? (
              messages.map((message) => (
                <article className={`message ${message.role} ${message.status ?? "done"}`} key={message.id}>
                  <div className="messageMeta">
                    <span>{message.role === "user" ? "You" : "Agent"}</span>
                    {message.usage ? <small>{formatTokens(message.usage.tokens)} tok</small> : null}
                  </div>
                  <div className="messageBubble">
                    {message.content}
                    {message.status === "streaming" ? <span className="caret" aria-hidden="true" /> : null}
                  </div>
                </article>
              ))
            ) : (
              <div className="emptyDialog">Start a dialog</div>
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

function buildComparisonRows(timeline: TokenTimelineRow[], usage: TokenUsage | null) {
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
      dialog: "Overflow",
      tokens: contextWindowTokens ? `>${formatTokens(contextWindowTokens)}` : "window + 1",
      cost: "-",
      behavior: usage?.failureMode ? "Blocked" : "413 guard",
    },
  ];
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

  return {
    ...usage,
    tokens,
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
  if (value > 0 && value < 0.000001) {
    return "<$0.000001";
  }

  return `$${value.toFixed(6)}`;
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
