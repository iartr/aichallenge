export const MODEL_OPTIONS = [
  "gpt-5.5",
  "gpt-5.5-pro-2026-04-23",
  "gpt-5.5-2026-04-23",
  "gpt-5.4-pro-2026-03-05",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-mini-2026-03-17",
  "gpt-5.4-nano-2026-03-17",
] as const;

export type ModelOption = (typeof MODEL_OPTIONS)[number];

export function isKnownModel(model: string): model is ModelOption {
  return MODEL_OPTIONS.includes(model as ModelOption);
}
