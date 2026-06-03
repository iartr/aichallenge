"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  ANTHROPIC_THINKING_DISPLAYS,
  MODEL_OPTIONS,
  OPENAI_REASONING_SUMMARIES,
  PROVIDER_OPTIONS,
  TEXT_VERBOSITIES,
  getModelOption,
  getModelsForProvider,
  type AnthropicThinkingMode,
  type ModelId,
  type ModelOption,
  type OpenAIReasoningEffort,
  type OpenAISamplingControl,
  type ProviderOption,
} from "@/lib/models";

type ResponseState =
  | {
      status: "idle";
      request: unknown;
      response: unknown;
      outputText: string;
      message: string;
    }
  | {
      status: "loading";
      request: unknown;
      response: unknown;
      outputText: string;
      message: string;
    }
  | {
      status: "done" | "error";
      request: unknown;
      response: unknown;
      outputText: string;
      message: string;
    };

const DEFAULT_INPUT = "Explain how prompt caching helps repeated API calls.";

type Sampler = "temperature" | "top_p";

export function RawConsole() {
  const [secret, setSecret] = useState("");
  const [provider, setProvider] = useState<ProviderOption>("openai");
  const [model, setModel] = useState<ModelId>("gpt-5.5");
  const [systemPrompt, setSystemPrompt] = useState("You are a precise technical assistant.");
  const [userPrompt, setUserPrompt] = useState("");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [text, setText] = useState(DEFAULT_INPUT);
  const [temperature, setTemperature] = useState("0.2");
  const [topP, setTopP] = useState("");
  const [activeSampler, setActiveSampler] = useState<Sampler | null>("temperature");
  const [topK, setTopK] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("1200");
  const [openAIReasoningEffort, setOpenAIReasoningEffort] = useState<OpenAIReasoningEffort>("off");
  const [openAIReasoningSummary, setOpenAIReasoningSummary] = useState("off");
  const [textVerbosity, setTextVerbosity] = useState("medium");
  const [anthropicThinkingMode, setAnthropicThinkingMode] = useState<AnthropicThinkingMode>("disabled");
  const [thinkingBudgetTokens, setThinkingBudgetTokens] = useState("4096");
  const [thinkingDisplay, setThinkingDisplay] = useState("summarized");
  const [anthropicEffort, setAnthropicEffort] = useState("");
  const [state, setState] = useState<ResponseState>({
    status: "idle",
    request: null,
    response: null,
    outputText: "",
    message: "Ready",
  });

  const modelConfig = getModelOption(model) ?? MODEL_OPTIONS[0];
  const modelsForProvider = useMemo(() => getModelsForProvider(provider), [provider]);
  const isOpenAI = modelConfig.provider === "openai";
  const isAnthropic = modelConfig.provider === "anthropic";
  const anthropicThinkingEnabled = isAnthropic && anthropicThinkingMode !== "disabled";
  const supportsTemperature = modelSupportsOpenAISampling(modelConfig, "temperature");
  const supportsTopP = modelSupportsOpenAISampling(modelConfig, "top_p");
  const temperatureDisabledReason =
    isOpenAI && !supportsTemperature
      ? "unsupported by model"
      : anthropicThinkingEnabled
      ? "blocked by thinking"
      : activeSampler === "top_p"
        ? "top_p active"
        : "";
  const topPDisabledReason =
    isOpenAI && !supportsTopP ? "unsupported by model" : activeSampler === "temperature" ? "temperature active" : "";
  const topKDisabledReason = isOpenAI
    ? "unsupported by OpenAI"
    : anthropicThinkingEnabled
      ? "blocked by thinking"
      : "";
  const reasoningSummaryDisabled = !isOpenAI || openAIReasoningEffort === "off" || openAIReasoningEffort === "none";
  const thinkingDisplayDisabled = !anthropicThinkingEnabled;
  const manualThinking = isAnthropic && anthropicThinkingMode === "manual";
  const anthroTopPMin = anthropicThinkingEnabled ? 0.95 : 0;
  const maxOutputTokensNumber = Number(maxOutputTokens);
  const thinkingBudgetTokensNumber = Number(thinkingBudgetTokens);
  const manualBudgetMax =
    manualThinking && Number.isFinite(maxOutputTokensNumber) ? Math.max(1024, maxOutputTokensNumber - 1) : undefined;
  const maxTokensMin =
    manualThinking && Number.isFinite(thinkingBudgetTokensNumber) ? thinkingBudgetTokensNumber + 1 : 1;

  const disabledPreview = useMemo(
    () => ({
      seed: "unsupported by selected API",
      frequency_penalty: "unsupported by selected API",
      presence_penalty: "unsupported by selected API",
    }),
    [],
  );

  function applyModelDefaults(nextModel: ModelId) {
    const nextConfig = getModelOption(nextModel);

    if (!nextConfig) {
      return;
    }

    if (nextConfig.provider === "openai") {
      setOpenAIReasoningEffort(nextConfig.defaultReasoningEffort);
      setOpenAIReasoningSummary("off");
      setTextVerbosity("medium");
      setAnthropicThinkingMode("disabled");
      setAnthropicEffort("");
      setThinkingBudgetTokens("4096");
      setTopK("");

      if (nextConfig.samplingControls.includes("temperature")) {
        if (!temperature && !topP) {
          setTemperature("0.2");
          setActiveSampler("temperature");
        }
      } else {
        setTemperature("");

        if (!nextConfig.samplingControls.includes("top_p")) {
          setTopP("");
          setActiveSampler(null);
        } else if (activeSampler === "temperature") {
          setActiveSampler(topP ? "top_p" : null);
        }
      }

      if (!nextConfig.samplingControls.includes("top_p")) {
        setTopP("");

        if (activeSampler === "top_p") {
          setActiveSampler(nextConfig.samplingControls.includes("temperature") && temperature ? "temperature" : null);
        }
      }

      return;
    }

    setAnthropicThinkingMode(nextConfig.defaultThinkingMode);
    setAnthropicEffort(nextConfig.defaultEffort ?? "");
    setOpenAIReasoningEffort("off");
    setOpenAIReasoningSummary("off");
    setTextVerbosity("medium");

    if (nextConfig.defaultThinkingMode !== "disabled") {
      setTemperature("");
      setTopK("");
      setActiveSampler(topP ? "top_p" : null);

      if (topP && Number(topP) < 0.95) {
        setTopP("1");
        setActiveSampler("top_p");
      }
    }
  }

  function handleProviderChange(nextProvider: ProviderOption) {
    const [nextModel] = getModelsForProvider(nextProvider);

    setProvider(nextProvider);
    setModel(nextModel.id);
    applyModelDefaults(nextModel.id);
  }

  function handleModelChange(nextModel: ModelId) {
    setModel(nextModel);
    applyModelDefaults(nextModel);
  }

  function handleTemperatureChange(value: string) {
    setTemperature(value);

    if (value) {
      setTopP("");
      setActiveSampler("temperature");
      return;
    }

    if (activeSampler === "temperature") {
      setActiveSampler(null);
    }
  }

  function handleTopPChange(value: string) {
    setTopP(value);

    if (value) {
      setTemperature("");
      setActiveSampler("top_p");
      return;
    }

    if (activeSampler === "top_p") {
      setActiveSampler(null);
    }
  }

  function handleAnthropicThinkingMode(nextMode: AnthropicThinkingMode) {
    setAnthropicThinkingMode(nextMode);

    if (nextMode !== "disabled") {
      setTemperature("");
      setTopK("");
      setActiveSampler(topP ? "top_p" : null);

      if (topP && Number(topP) < 0.95) {
        setTopP("1");
        setActiveSampler("top_p");
      }

      if (nextMode === "manual") {
        const budget = Number(thinkingBudgetTokens);
        const maxTokens = Number(maxOutputTokens);

        if (Number.isFinite(budget) && Number.isFinite(maxTokens) && maxTokens <= budget) {
          setMaxOutputTokens(String(budget + 1));
        }
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({
      status: "loading",
      request: state.request,
      response: state.response,
      outputText: "",
      message: "Waiting for response",
    });

    const payload: Record<string, string> = {
      secret,
      provider,
      model,
      text,
      systemPrompt,
      userPrompt,
      assistantPrompt,
      max_output_tokens: maxOutputTokens,
    };

    if (activeSampler === "temperature" && temperature && (!isOpenAI || supportsTemperature)) {
      payload.temperature = temperature;
    }

    if (activeSampler === "top_p" && topP && (!isOpenAI || supportsTopP)) {
      payload.top_p = topP;
    }

    if (isOpenAI) {
      payload.reasoning_effort = openAIReasoningEffort;
      payload.reasoning_summary = reasoningSummaryDisabled ? "off" : openAIReasoningSummary;
      payload.text_verbosity = textVerbosity;
    }

    if (isAnthropic) {
      payload.thinking_mode = anthropicThinkingMode;
      payload.thinking_display = anthropicThinkingEnabled ? thinkingDisplay : "";
      payload.anthropic_effort = anthropicEffort;

      if (manualThinking) {
        payload.thinking_budget_tokens = thinkingBudgetTokens;
      }

      if (topK && !topKDisabledReason) {
        payload.top_k = topK;
      }
    }

    try {
      const response = await fetch("/api/model-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as {
        request?: unknown;
        response?: unknown;
        outputText?: unknown;
        error?: {
          message?: unknown;
        };
      };

      if (!response.ok) {
        const message = readResponseErrorMessage(data, response.status);

        setState({
          status: "error",
          request: data.request ?? null,
          response: data.response ?? data,
          outputText: message,
          message,
        });
        return;
      }

      const outputText = typeof data.outputText === "string" ? data.outputText : "";

      setState({
        status: "done",
        request: data.request ?? null,
        response: data.response ?? data,
        outputText,
        message: outputText ? "Done" : "No text output",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";

      setState({
        status: "error",
        request: null,
        response: {
          error: {
            message,
          },
        },
        outputText: message,
        message: "Network error",
      });
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Provider API Console</p>
          <h1>Raw Console</h1>
        </div>
        <div className={`status ${state.status}`} role="status" aria-live="polite">
          {state.message}
        </div>
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

          <div className="grid two">
            <label className="field">
              <span>Provider</span>
              <select
                value={provider}
                onChange={(event) => handleProviderChange(event.target.value as ProviderOption)}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(event) => handleModelChange(event.target.value as ModelId)}>
                {modelsForProvider.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isOpenAI ? (
            <div className="section">
              <div className="sectionTitle">OpenAI thinking</div>
              <label className="field">
                <span>reasoning.effort</span>
                <select
                  value={openAIReasoningEffort}
                  onChange={(event) => {
                    const nextEffort = event.target.value as OpenAIReasoningEffort;
                    setOpenAIReasoningEffort(nextEffort);

                    if (nextEffort === "off" || nextEffort === "none") {
                      setOpenAIReasoningSummary("off");
                    }
                  }}
                >
                  {modelConfig.provider === "openai"
                    ? modelConfig.reasoningEfforts.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))
                    : null}
                </select>
              </label>

              <div className="grid two">
                <label className="field">
                  <span>reasoning.summary</span>
                  <select
                    value={reasoningSummaryDisabled ? "off" : openAIReasoningSummary}
                    disabled={reasoningSummaryDisabled}
                    onChange={(event) => setOpenAIReasoningSummary(event.target.value)}
                  >
                    {OPENAI_REASONING_SUMMARIES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>text.verbosity</span>
                  <select value={textVerbosity} onChange={(event) => setTextVerbosity(event.target.value)}>
                    {TEXT_VERBOSITIES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : null}

          {isAnthropic ? (
            <div className="section">
              <div className="sectionTitle">Anthropic thinking</div>
              <div className="grid two">
                <label className="field">
                  <span>thinking.type</span>
                  <select
                    value={anthropicThinkingMode}
                    onChange={(event) => handleAnthropicThinkingMode(event.target.value as AnthropicThinkingMode)}
                  >
                    {modelConfig.provider === "anthropic"
                      ? modelConfig.thinkingModes.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))
                      : null}
                  </select>
                </label>

                <label className="field">
                  <span>output_config.effort</span>
                  <select
                    value={anthropicEffort}
                    disabled={modelConfig.provider !== "anthropic" || modelConfig.efforts.length === 0}
                    onChange={(event) => setAnthropicEffort(event.target.value)}
                  >
                    <option value="">default</option>
                    {modelConfig.provider === "anthropic"
                      ? modelConfig.efforts.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))
                      : null}
                  </select>
                </label>
              </div>

              <div className="grid two">
                <label className="field">
                  <span>budget_tokens</span>
                  <input
                    type="number"
                    min="1024"
                    max={manualBudgetMax}
                    step="1"
                    value={thinkingBudgetTokens}
                    disabled={!manualThinking}
                    onChange={(event) => setThinkingBudgetTokens(event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>thinking.display</span>
                  <select
                    value={thinkingDisplayDisabled ? "summarized" : thinkingDisplay}
                    disabled={thinkingDisplayDisabled}
                    onChange={(event) => setThinkingDisplay(event.target.value)}
                  >
                    {ANTHROPIC_THINKING_DISPLAYS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : null}

          <div className="grid two">
            <label className="field">
              <span>temperature</span>
              <input
                type="number"
                min="0"
                max={isAnthropic ? 1 : 2}
                step="0.1"
                value={temperatureDisabledReason === "unsupported by model" ? "" : temperature}
                disabled={Boolean(temperatureDisabledReason)}
                title={temperatureDisabledReason}
                onChange={(event) => handleTemperatureChange(event.target.value)}
              />
            </label>
            <label className="field">
              <span>top_p</span>
              <input
                type="number"
                min={anthroTopPMin}
                max="1"
                step="0.05"
                value={topPDisabledReason === "unsupported by model" ? "" : topP}
                disabled={Boolean(topPDisabledReason)}
                title={topPDisabledReason}
                onChange={(event) => handleTopPChange(event.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>top_k</span>
            <input
              type="number"
              min="0"
              step="1"
              value={topKDisabledReason ? "" : topK}
              disabled={Boolean(topKDisabledReason)}
              title={topKDisabledReason}
              placeholder={topKDisabledReason || "Optional"}
              onChange={(event) => setTopK(event.target.value)}
            />
          </label>

          <label className="field">
            <span>{isAnthropic ? "max_tokens" : "max_output_tokens"}</span>
            <input
              type="number"
              min={maxTokensMin}
              max={modelConfig.provider === "anthropic" ? modelConfig.maxTokens : undefined}
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
            {state.status === "loading" ? "Waiting..." : "Send request"}
          </button>
        </section>

        <section className="panes" aria-label="Console output">
          <JsonPane title="raw json input" value={state.request} empty="Request appears here after submit." />
          <TextPane
            title="llm output"
            text={state.outputText}
            status={state.status}
            empty="LLM text appears here after submit."
          />
        </section>
      </form>
    </main>
  );
}

function modelSupportsOpenAISampling(
  modelConfig: ModelOption,
  control: OpenAISamplingControl,
) {
  return modelConfig.provider !== "openai" || modelConfig.samplingControls.includes(control);
}

function JsonPane({ title, value, empty }: { title: string; value: unknown; empty: string }) {
  return (
    <article className="consolePane jsonPane">
      <div className="paneTitle">{title}</div>
      <pre>{value === null ? empty : JSON.stringify(value, null, 2)}</pre>
    </article>
  );
}

function TextPane({
  title,
  text,
  status,
  empty,
}: {
  title: string;
  text: string;
  status: ResponseState["status"];
  empty: string;
}) {
  const isLoading = status === "loading";
  const content = isLoading ? "Waiting for LLM response..." : text || empty;

  return (
    <article className={`consolePane textPane ${isLoading ? "loadingPane" : ""}`} aria-busy={isLoading}>
      <div className="paneTitle">{title}</div>
      <pre className="textOutput">{content}</pre>
    </article>
  );
}

function readResponseErrorMessage(
  data: {
    response?: unknown;
    error?: {
      message?: unknown;
    };
  },
  status: number,
) {
  if (typeof data.error?.message === "string" && data.error.message.trim()) {
    return data.error.message.trim();
  }

  const providerError = readProviderErrorMessage(data.response);

  return providerError || `Request failed with ${status}`;
}

function readProviderErrorMessage(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.message === "string" && value.message.trim()) {
    return value.message.trim();
  }

  if (isRecord(value.error) && typeof value.error.message === "string" && value.error.message.trim()) {
    return value.error.message.trim();
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
