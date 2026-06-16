import {
  DEFAULT_ASSISTANT_PROMPT_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_PROMPT_TEMPLATE,
  getAdminSettings,
  updateAdminSettings,
} from "../lib/admin-settings";
import { getSql } from "../lib/db";

// Refreshes the persisted admin_settings analysis prompts to the current code
// defaults. getAdminSettings() reads from the DB row (seeded once), so changes
// to DEFAULT_USER_PROMPT_TEMPLATE only take effect after running this.
async function main() {
  const current = await getAdminSettings();

  if (current.userPromptTemplate.includes('"competencies"')) {
    console.log("Analysis prompt already includes competencies — nothing to refresh.");
    await getSql().end({ timeout: 5 });
    return;
  }

  const settings = await updateAdminSettings({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
    assistantPromptTemplate: DEFAULT_ASSISTANT_PROMPT_TEMPLATE,
  });

  await getSql().end({ timeout: 5 });
  console.log(`Refreshed analysis prompts. provider=${settings.llmProvider} model=${settings.llmModel}`);
}

main().catch(async (error: unknown) => {
  try {
    await getSql().end({ timeout: 5 });
  } catch {
    // Ignore shutdown errors while surfacing the original failure.
  }

  console.error(error instanceof Error ? error.message : "Prompt refresh failed.");
  process.exitCode = 1;
});
