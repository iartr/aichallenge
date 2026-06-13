/**
 * Day 10 comparison experiment: runs the SAME "собираем ТЗ" dialog through each
 * context-management strategy (full / sliding window / facts / summary) against
 * the real OpenAI API and prints markdown tables (per-turn tokens, totals, recall
 * quality) for the PR. Branching is a UI-only strategy (it explores alternatives
 * rather than trimming context) and is demonstrated in the app, not here.
 *
 * Usage: npm run compare:strategies
 * Env:   OPENAI_API_KEY (required, read from .env), OPENAI_CHAT_MODEL /
 *        OPENAI_FACTS_MODEL / OPENAI_SUMMARY_MODEL (optional). No DB is used.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAT_AGENT_INSTRUCTIONS,
  DEFAULT_OPENAI_CHAT_MODEL,
  OpenAIChatAgent,
  type AgentChatMessage,
} from "../lib/chat-agent";
import {
  applySlidingWindow,
  buildFactsStep,
  extractFacts,
  type ContextStrategy,
  type FactsState,
} from "../lib/context-strategies";
import { compressHistory, summarizeMessages, type CompressionState } from "../lib/history-compression";
import { countHistoryTokens } from "../lib/token-usage";

const WINDOW = 6;

const SCRIPT = [
  "Делаем лендинг для кофейни. Цель — собрать заявки на доставку.",
  "Бюджет 1500 евро, дедлайн — 1 августа.",
  "Стек: Next.js + Tailwind, без бэкенда, формы через Formspree.",
  "Языки: португальский и английский.",
  "Важно: тёмная тема и быстрая загрузка (Lighthouse 90+).",
  "Ограничение: без cookie-баннеров, без сторонней аналитики.",
  "Назови один цвет.",
  "Назови одно животное.",
  "Назови одну страну.",
  "Назови одну планету.",
  "Какая у нас цель проекта и дедлайн?",
  "Какой стек и какие языки мы выбрали?",
  "Какие ограничения по аналитике и баннерам?",
  "Собери финальное короткое ТЗ по пунктам.",
];

const RECALL_COUNT = 4;
const STRATEGIES: ContextStrategy[] = ["full", "sliding_window", "facts", "summary"];

type TurnStat = {
  turn: number;
  question: string;
  sentMessages: number;
  estimatedSentTokens: number;
  estimatedFullTokens: number;
  providerInputTokens: number;
  totalTokens: number;
  costUsd: number;
  helperTokens: number;
  helperCostUsd: number;
  answer: string;
};

async function runStrategy(strategy: ContextStrategy, apiKey: string, model: string): Promise<TurnStat[]> {
  const agent = new OpenAIChatAgent({ apiKey, model, maxOutputTokens: 500 });
  const messages: AgentChatMessage[] = [];
  let factsState: FactsState = { facts: [], factsCoveredCount: 0 };
  let summaryState: CompressionState = { summary: "", summaryCoveredCount: 0 };
  const stats: TurnStat[] = [];

  for (const [index, text] of SCRIPT.entries()) {
    messages.push({ role: "user", content: text });

    let sentMessages: AgentChatMessage[] = messages;
    let instructions = CHAT_AGENT_INSTRUCTIONS;
    let helperTokens = 0;
    let helperCostUsd = 0;

    if (strategy === "sliding_window") {
      sentMessages = applySlidingWindow(messages, WINDOW);
    } else if (strategy === "facts") {
      const step = await buildFactsStep(
        messages,
        factsState,
        ({ previousFacts, messages: toFold }) => extractFacts({ apiKey, previousFacts, messages: toFold, model }),
        { windowSize: WINDOW },
      );

      if (step.factsError) {
        throw new Error(`Facts extractor failed on turn ${index + 1}: ${step.factsError}`);
      }

      factsState = step.state;
      sentMessages = step.sentMessages;
      instructions = step.instructions;
      helperTokens = step.factsUsage?.totalTokens ?? 0;
      helperCostUsd = step.factsUsage?.estimatedCostUsd ?? 0;
    } else if (strategy === "summary") {
      const step = await compressHistory(messages, summaryState, ({ previousSummary, messages: toFold }) =>
        summarizeMessages({ apiKey, previousSummary, messages: toFold, model }),
      );

      if (step.summarizerError) {
        throw new Error(`Summarizer failed on turn ${index + 1}: ${step.summarizerError}`);
      }

      summaryState = step.state;
      sentMessages = step.sentMessages;
      instructions = step.instructions;
      helperTokens = step.summarizerUsage?.totalTokens ?? 0;
      helperCostUsd = step.summarizerUsage?.estimatedCostUsd ?? 0;
    }

    const result = await agent.respond(sentMessages, { instructions });

    stats.push({
      turn: index + 1,
      question: text,
      sentMessages: sentMessages.length,
      estimatedSentTokens: countHistoryTokens(sentMessages, instructions),
      estimatedFullTokens: countHistoryTokens(messages, CHAT_AGENT_INSTRUCTIONS),
      providerInputTokens: result.usage.historyTokens,
      totalTokens: result.usage.totalTokens,
      costUsd: result.usage.estimatedCostUsd,
      helperTokens,
      helperCostUsd,
      answer: result.answer.replace(/\s+/g, " ").trim(),
    });

    messages.push({ role: "assistant", content: result.answer });
    process.stderr.write(`  [${strategy}] turn ${index + 1}/${SCRIPT.length}\n`);
  }

  return stats;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function fmt(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function usd(value: number) {
  return `$${value.toFixed(6)}`;
}

function truncate(value: string, max = 90) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function label(strategy: ContextStrategy) {
  return {
    full: "Full",
    sliding_window: "Sliding window",
    facts: "Sticky facts",
    branching: "Branching",
    summary: "Summary",
  }[strategy];
}

function perTurnTable(stats: TurnStat[]) {
  const lines = [
    "| Turn | Sent msgs | Prompt tok (provider) | Total tok | Helper tok | Cost (incl. helper) |",
    "|---:|---:|---:|---:|---:|---:|",
  ];

  for (const stat of stats) {
    lines.push(
      `| ${stat.turn} | ${stat.sentMessages} | ${fmt(stat.providerInputTokens)} | ${fmt(stat.totalTokens)} | ${stat.helperTokens ? fmt(stat.helperTokens) : "—"} | ${usd(stat.costUsd + stat.helperCostUsd)} |`,
    );
  }

  return lines.join("\n");
}

function loadDotEnv() {
  try {
    const content = readFileSync(resolve(import.meta.dirname, "..", ".env"), "utf8");

    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);

      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // .env is optional when variables are already exported.
  }
}

async function main() {
  loadDotEnv();

  const apiKey = process.env.OPENAI_API_KEY ?? "";

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required (set it in .env or the environment).");
  }

  const model = process.env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_CHAT_MODEL;
  process.stderr.write(`Model: ${model}\n`);

  const runs: Record<string, TurnStat[]> = {};

  for (const strategy of STRATEGIES) {
    process.stderr.write(`Running strategy "${strategy}" (${SCRIPT.length} turns)...\n`);
    runs[strategy] = await runStrategy(strategy, apiKey, model);
  }

  const out: string[] = [];
  out.push(`## Strategy comparison (${SCRIPT.length} turns, window N=${WINDOW}, model \`${model}\`)`);
  out.push("");

  for (const strategy of STRATEGIES) {
    out.push(`### Per-turn — ${label(strategy)}`);
    out.push("");
    out.push(perTurnTable(runs[strategy]));
    out.push("");
  }

  out.push("### Totals");
  out.push("");
  out.push("| Strategy | Prompt tok (provider) | Helper tok | Total tok | Cost (incl. helper) | Last-turn prompt tok |");
  out.push("|---|---:|---:|---:|---:|---:|");

  for (const strategy of STRATEGIES) {
    const stats = runs[strategy];
    const prompt = sum(stats.map((stat) => stat.providerInputTokens));
    const helper = sum(stats.map((stat) => stat.helperTokens));
    const total = sum(stats.map((stat) => stat.totalTokens));
    const cost = sum(stats.map((stat) => stat.costUsd + stat.helperCostUsd));
    const lastPrompt = stats[stats.length - 1]?.providerInputTokens ?? 0;

    out.push(
      `| ${label(strategy)} | ${fmt(prompt)} | ${helper ? fmt(helper) : "—"} | ${fmt(total)} | ${usd(cost)} | ${fmt(lastPrompt)} |`,
    );
  }

  out.push("");
  out.push("### Recall quality (facts planted in turns 1-6, asked after filler)");
  out.push("");
  out.push(`| Question | ${STRATEGIES.map(label).join(" | ")} |`);
  out.push(`|---|${STRATEGIES.map(() => "---").join("|")}|`);

  for (let index = SCRIPT.length - RECALL_COUNT; index < SCRIPT.length; index += 1) {
    const answers = STRATEGIES.map((strategy) => truncate(runs[strategy][index]?.answer ?? ""));
    out.push(`| ${truncate(SCRIPT[index], 40)} | ${answers.join(" | ")} |`);
  }

  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
