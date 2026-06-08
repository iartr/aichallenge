"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status?: "streaming" | "done" | "error";
};

type AgentChatResponse = {
  answer?: unknown;
  model?: unknown;
  error?: {
    message?: unknown;
  };
};

const INTRO_MESSAGE: ChatMessage = {
  id: "intro",
  role: "assistant",
  content: "Готов к диалогу. Напишите простой запрос, агент отправит его в LLM и сохранит контекст.",
  status: "done",
};

export function ChatApp() {
  const [secret, setSecret] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([INTRO_MESSAGE]);
  const [status, setStatus] = useState<"idle" | "loading" | "typing" | "error">("idle");
  const [statusText, setStatusText] = useState("Ready");
  const [model, setModel] = useState("");
  const runIdRef = useRef(0);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const canSend = Boolean(secret.trim()) && Boolean(input.trim()) && status !== "loading" && status !== "typing";
  const visibleHistory = useMemo(() => messages.filter((message) => message.id !== "intro"), [messages]);

  useEffect(() => {
    const chatBody = chatBodyRef.current;

    if (!chatBody) {
      return;
    }

    chatBody.scrollTop = chatBody.scrollHeight;
  }, [messages]);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!canSend) {
      return;
    }

    const content = input.trim();
    const userMessage = createMessage("user", content);
    const assistantMessage = createMessage("assistant", "", "streaming");
    const nextMessages = [...messages, userMessage, assistantMessage];
    const requestMessages = [...messages, userMessage]
      .filter((message) => message.id !== "intro" && message.status !== "error")
      .map(({ role, content: messageContent }) => ({
        role,
        content: messageContent,
      }));
    const currentRun = runIdRef.current + 1;

    runIdRef.current = currentRun;
    setInput("");
    setMessages(nextMessages);
    setStatus("loading");
    setStatusText("Waiting for agent");

    try {
      const response = await fetch("/api/agent-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          secret,
          messages: requestMessages,
        }),
      });
      const data = (await response.json()) as AgentChatResponse;

      if (!response.ok) {
        throw new Error(readErrorMessage(data, response.status));
      }

      const answer = typeof data.answer === "string" ? data.answer : "";

      if (!answer) {
        throw new Error("Agent returned an empty answer.");
      }

      if (typeof data.model === "string") {
        setModel(data.model);
      }

      setStatus("typing");
      setStatusText("Typing");
      await typeAssistantAnswer(assistantMessage.id, answer, currentRun);

      if (runIdRef.current === currentRun) {
        setStatus("idle");
        setStatusText("Ready");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed.";

      if (runIdRef.current !== currentRun) {
        return;
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
      await delay(12);
    }
  }

  function clearChat() {
    runIdRef.current += 1;
    setMessages([INTRO_MESSAGE]);
    setInput("");
    setStatus("idle");
    setStatusText("Ready");
    setModel("");
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void submit();
  }

  return (
    <main className="chatShell">
      <section className="chatPanel" aria-label="AI chat agent">
        <header className="chatHeader">
          <div>
            <p className="chatEyebrow">Week2 / Day1</p>
            <h1>Simple Chat Agent</h1>
          </div>
          <div className={`agentStatus ${status}`} role="status" aria-live="polite">
            <span>{statusText}</span>
            {model ? <small>{model}</small> : null}
          </div>
        </header>

        <div className="chatBody" aria-live="polite" ref={chatBodyRef}>
          {messages.map((message) => (
            <article className={`message ${message.role} ${message.status ?? "done"}`} key={message.id}>
              <div className="messageMeta">{message.role === "user" ? "You" : "Agent"}</div>
              <div className="messageBubble">
                {message.content}
                {message.status === "streaming" ? <span className="caret" aria-hidden="true" /> : null}
              </div>
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={submit}>
          <label className="secretField">
            <span>Secret</span>
            <input
              type="password"
              value={secret}
              autoComplete="current-password"
              placeholder="Required"
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>

          <label className="promptField">
            <span className="srOnly">Message</span>
            <textarea
              rows={3}
              value={input}
              placeholder={visibleHistory.length ? "Продолжить диалог..." : "Напишите первый запрос..."}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
          </label>

          <div className="composerActions">
            <button className="secondaryButton" type="button" onClick={clearChat}>
              Clear
            </button>
            <button className="sendButton" type="submit" disabled={!canSend}>
              {status === "loading" || status === "typing" ? "Sending..." : "Send"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function createMessage(role: ChatRole, content: string, status: ChatMessage["status"] = "done"): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    status,
  };
}

function readErrorMessage(data: AgentChatResponse, status: number) {
  if (typeof data.error?.message === "string" && data.error.message.trim()) {
    return data.error.message.trim();
  }

  return `Request failed with ${status}.`;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
