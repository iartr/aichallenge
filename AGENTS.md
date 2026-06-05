# Agent Rules

## Branches

- Work for each task must happen in a branch named `week{N}/day{N}`.
- Examples: `week1/day1`, `week12/day3`.
- Do not work directly on `main`.
- Keep one task per branch unless the user explicitly asks otherwise.

## Secrets

- Never commit `.env`, `.env.local`, API keys, tokens, or secrets.
- Keep `OPENAI_API_KEY` and `SECRET` in local environment files only.

## Testing

- Для тестирования бери значения secrets из railway и проверяй в браузере работу на простых запросах.
- Ни в коем случае не тестируй на тяжелых моделях версии gpt-pro & opus.