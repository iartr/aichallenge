"use client";

import { FormEvent, useMemo, useState } from "react";
import { MODEL_OPTIONS } from "@/lib/models";

type ResponseState =
  | {
      status: "idle";
      request: unknown;
      response: unknown;
      message: string;
    }
  | {
      status: "loading";
      request: unknown;
      response: unknown;
      message: string;
    }
  | {
      status: "done" | "error";
      request: unknown;
      response: unknown;
      message: string;
    };

const DEFAULT_INPUT = "Explain how prompt caching helps repeated API calls.";

export function RawConsole() {
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState(MODEL_OPTIONS[0]);
  const [systemPrompt, setSystemPrompt] = useState("You are a precise technical assistant.");
  const [userPrompt, setUserPrompt] = useState("");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [text, setText] = useState(DEFAULT_INPUT);
  const [temperature, setTemperature] = useState("0.2");
  const [topP, setTopP] = useState("1");
  const [maxOutputTokens, setMaxOutputTokens] = useState("1200");
  const [state, setState] = useState<ResponseState>({
    status: "idle",
    request: null,
    response: null,
    message: "Ready",
  });

  const disabledPreview = useMemo(
    () => ({
      top_k: "unsupported by Responses API",
      seed: "unsupported by Responses API",
      frequency_penalty: "unsupported by Responses API",
      presence_penalty: "unsupported by Responses API",
    }),
    [],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({
      status: "loading",
      request: state.request,
      response: state.response,
      message: "Sending",
    });

    const payload = {
      secret,
      model,
      text,
      systemPrompt,
      userPrompt,
      assistantPrompt,
      temperature,
      top_p: topP,
      max_output_tokens: maxOutputTokens,
    };

    try {
      const response = await fetch("/api/openai-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as {
        request?: unknown;
        response?: unknown;
        error?: {
          message?: string;
        };
      };

      if (!response.ok) {
        setState({
          status: "error",
          request: data.request ?? null,
          response: data.response ?? data,
          message: data.error?.message ?? `Request failed with ${response.status}`,
        });
        return;
      }

      setState({
        status: "done",
        request: data.request ?? null,
        response: data.response ?? data,
        message: "Done",
      });
    } catch (error) {
      setState({
        status: "error",
        request: null,
        response: {
          error: {
            message: error instanceof Error ? error.message : "Network error",
          },
        },
        message: "Network error",
      });
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">OpenAI Responses API</p>
          <h1>Raw Console</h1>
        </div>
        <div className={`status ${state.status}`}>{state.message}</div>
      </header>

      <form className="workspace" onSubmit={submit}>
        <section className="controls" aria-label="Request controls">
          <label className="field">
            <span>Secret</span>
            <input
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Required"
            />
          </label>

          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(event) => setModel(event.target.value as typeof model)}>
              {MODEL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="grid two">
            <label className="field">
              <span>temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
              />
            </label>
            <label className="field">
              <span>top_p</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={topP}
                onChange={(event) => setTopP(event.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>max_output_tokens</span>
            <input
              type="number"
              min="1"
              step="1"
              value={maxOutputTokens}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
            />
          </label>

          <div className="unsupported" aria-label="Unsupported controls">
            {Object.entries(disabledPreview).map(([name, reason]) => (
              <label className="field muted" key={name}>
                <span>{name}</span>
                <input value={reason} disabled readOnly />
              </label>
            ))}
          </div>

          <label className="field">
            <span>system prompt</span>
            <textarea
              rows={3}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>

          <label className="field">
            <span>assistant prompt</span>
            <textarea
              rows={3}
              value={assistantPrompt}
              onChange={(event) => setAssistantPrompt(event.target.value)}
              placeholder="Optional prior assistant message"
            />
          </label>

          <label className="field">
            <span>user prompt</span>
            <textarea
              rows={3}
              value={userPrompt}
              onChange={(event) => setUserPrompt(event.target.value)}
              placeholder="Optional prefix before main input"
            />
          </label>

          <label className="field">
            <span>input text</span>
            <textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} />
          </label>

          <button className="submit" type="submit" disabled={state.status === "loading"}>
            {state.status === "loading" ? "Sending..." : "Send request"}
          </button>
        </section>

        <section className="panes" aria-label="Raw JSON">
          <JsonPane title="raw json input" value={state.request} empty="Request appears here after submit." />
          <JsonPane title="raw json output" value={state.response} empty="Response appears here after submit." />
        </section>
      </form>
    </main>
  );
}

function JsonPane({ title, value, empty }: { title: string; value: unknown; empty: string }) {
  return (
    <article className="jsonPane">
      <div className="paneTitle">{title}</div>
      <pre>{value === null ? empty : JSON.stringify(value, null, 2)}</pre>
    </article>
  );
}
