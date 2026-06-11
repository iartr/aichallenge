/**
 * Day 9 comparison experiment: runs the same scripted dialog twice — without
 * and with history compression — against the real OpenAI API and prints
 * markdown tables (per-turn tokens, totals, recall quality) for the PR.
 *
 * Usage: npm run compare:compression
 * Env:   OPENAI_API_KEY (required, read from .env), OPENAI_CHAT_MODEL /
 *        OPENAI_SUMMARY_MODEL (optional). DATABASE_URL is not used — the
 *        dialog lives in memory and exercises the same lib code as the route.
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
  addSummarizerUsage,
  compressHistory,
  emptySummarizerUsageTotals,
  summarizeMessages,
  type CompressionState,
  type CompressionStepResult,
} from "../lib/history-compression";
import { countHistoryTokens } from "../lib/token-usage";

const FACT_TURNS = [
  "My name is Art.",
  "My cat is called Busya.",
  "My favorite number is 17.",
  "I live in Lisbon.",
  "My project is called aichallenge.",
];

const FILLER_TURNS = [
  "Name one color.",
  "Say a fruit.",
  "Name one animal.",
  "Say a country.",
  "Name one planet.",
  "Say a vegetable.",
  "Name one sport.",
  "Say a music genre.",
  "Name one metal.",
  "Say a season.",
  "Name one ocean.",
  "Say a weekday.",
  "Name one bird.",
  "Say a board game.",
  "Name one tree.",
];

const RECALL_TURNS = [
  "What is my name?",
  "What is my cat's name?",
  "What is my favorite number?",
  "Where do I live?",
];

const SCRIPT = [...FACT_TURNS, ...FILLER_TURNS, ...RECALL_TURNS];

type TurnStat = {
  turn: number;
  question: string;
  sentMessages: number;
  estimatedSentTokens: number;
  estimatedFullTokens: number;
  providerInputTokens: number;
  totalTokens: number;
  costUsd: number;
  summarizerTokens: number;
  summarizerCostUsd: number;
  answer: string;
};

async function runMode(compressionOn: boolean, apiKey: string, model: string): Promise<TurnStat[]> {
  const agent = new OpenAIChatAgent({ apiKey, model, maxOutputTokens: 600 });
  const messages: AgentChatMessage[] = [];
  let state: CompressionState = { summary: "", summaryCoveredCount: 0 };
  let totals = emptySummarizerUsageTotals();
  const stats: TurnStat[] = [];

  for (const [index, text] of SCRIPT.entries()) {
    messages.push({ role: "user", content: text });

    const step: CompressionStepResult = compressionOn
      ? await compressHistory(messages, state, ({ previousSummary, messages: messagesToFold }) =>
          summarizeMessages({ apiKey, previousSummary, messages: messagesToFold }),
        )
      : {
          state,
          sentMessages: messages,
          instructions: CHAT_AGENT_INSTRUCTIONS,
          summarizerUsage: null,
          summarizerError: null,
        };

    if (step.summarizerError) {
      throw new Error(`Summarizer failed on turn ${index + 1}: ${step.summarizerError}`);
    }

    const result = await agent.respond(step.sentMessages, { instructions: step.instructions });

    stats.push({
      turn: index + 1,
      question: text,
      sentMessages: step.sentMessages.length,
      estimatedSentTokens: countHistoryTokens(step.sentMessages, step.instructions),
      estimatedFullTokens: countHistoryTokens(messages, CHAT_AGENT_INSTRUCTIONS),
      providerInputTokens: result.usage.historyTokens,
      totalTokens: result.usage.totalTokens,
      costUsd: result.usage.estimatedCostUsd,
      summarizerTokens: step.summarizerUsage?.totalTokens ?? 0,
      summarizerCostUsd: step.summarizerUsage?.estimatedCostUsd ?? 0,
      answer: result.answer.replace(/\s+/g, " ").trim(),
    });

    state = step.state;

    if (step.summarizerUsage) {
      totals = addSummarizerUsage(totals, step.summarizerUsage);
    }

    messages.push({ role: "assistant", content: result.answer });
    process.stderr.write(`  [${compressionOn ? "on " : "off"}] turn ${index + 1}/${SCRIPT.length}\n`);
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

function truncate(value: string, max = 80) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function perTurnTable(stats: TurnStat[], compressionOn: boolean) {
  const lines = [
    "| Turn | Sent msgs | Prompt tok (est) | Prompt tok (provider) | Total tok | Summarizer tok | Cost |",
    "|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const stat of stats) {
    lines.push(
      `| ${stat.turn} | ${stat.sentMessages} | ${fmt(stat.estimatedSentTokens)} | ${fmt(stat.providerInputTokens)} | ${fmt(stat.totalTokens)} | ${compressionOn ? fmt(stat.summarizerTokens) : "—"} | ${usd(stat.costUsd + stat.summarizerCostUsd)} |`,
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

  process.stderr.write(`Model: ${model}\nRunning compression OFF (${SCRIPT.length} turns)...\n`);
  const off = await runMode(false, apiKey, model);
  process.stderr.write(`Running compression ON (${SCRIPT.length} turns)...\n`);
  const on = await runMode(true, apiKey, model);

  const offPrompt = sum(off.map((stat) => stat.providerInputTokens));
  const onPrompt = sum(on.map((stat) => stat.providerInputTokens));
  const offTotal = sum(off.map((stat) => stat.totalTokens));
  const onTotal = sum(on.map((stat) => stat.totalTokens));
  const onSummarizer = sum(on.map((stat) => stat.summarizerTokens));
  const offCost = sum(off.map((stat) => stat.costUsd));
  const onCost = sum(on.map((stat) => stat.costUsd + stat.summarizerCostUsd));

  const out: string[] = [];

  out.push(`## Compression comparison (${SCRIPT.length} turns, model \`${model}\`)`);
  out.push("");
  out.push("### Per-turn — compression OFF");
  out.push("");
  out.push(perTurnTable(off, false));
  out.push("");
  out.push("### Per-turn — compression ON");
  out.push("");
  out.push(perTurnTable(on, true));
  out.push("");
  out.push("### Totals");
  out.push("");
  out.push("| Metric | OFF | ON | Delta |");
  out.push("|---|---:|---:|---:|");
  out.push(`| Prompt tokens (provider, sum) | ${fmt(offPrompt)} | ${fmt(onPrompt)} | ${fmt(offPrompt - onPrompt)} saved |`);
  out.push(`| Total tokens (chat calls) | ${fmt(offTotal)} | ${fmt(onTotal)} | ${fmt(offTotal - onTotal)} |`);
  out.push(`| Summarizer overhead tokens | — | ${fmt(onSummarizer)} | +${fmt(onSummarizer)} |`);
  out.push(
    `| Net tokens (incl. summarizer) | ${fmt(offTotal)} | ${fmt(onTotal + onSummarizer)} | ${fmt(offTotal - onTotal - onSummarizer)} saved |`,
  );
  out.push(`| Cost (incl. summarizer) | ${usd(offCost)} | ${usd(onCost)} | ${usd(offCost - onCost)} saved |`);
  out.push(
    `| Last-turn prompt tokens | ${fmt(off[off.length - 1]?.providerInputTokens ?? 0)} | ${fmt(on[on.length - 1]?.providerInputTokens ?? 0)} | ${fmt((off[off.length - 1]?.providerInputTokens ?? 0) - (on[on.length - 1]?.providerInputTokens ?? 0))} saved |`,
  );
  out.push("");
  out.push("### Recall quality (facts planted in turns 1-5, asked after compression folds)");
  out.push("");
  out.push("| Question | Answer (OFF — full history) | Answer (ON — summary + last msgs) |");
  out.push("|---|---|---|");

  for (let index = SCRIPT.length - RECALL_TURNS.length; index < SCRIPT.length; index += 1) {
    out.push(
      `| ${SCRIPT[index]} | ${truncate(off[index]?.answer ?? "")} | ${truncate(on[index]?.answer ?? "")} |`,
    );
  }

  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
