import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsHome } from "./addAccount.js";
import { systemLanguage, type LanguageSetting } from "./i18n/index.js";
import { readJson, writeJson } from "./transcript/locate.js";

/** Whether the language question was asked, once per machine: below the home folder, not per account, and untouched by a settings reset. */
export function languagePromptFile(home = accountsHome.get()): string {
  return join(home, ".claude", "cco", "language.json");
}

/**
 * Whether the viewer asks at its start whether cco should speak German: the operating system is German,
 * no language is chosen (the setting is `system`) and it was never asked on this machine.
 */
export function shouldAskLanguage(setting: LanguageSetting): boolean {
  return setting === "system" && systemLanguage() === "de" && readJson<{ asked?: unknown }>(languagePromptFile())?.asked !== true;
}

/** Notes that the question was answered (or closed), so it never comes again. */
export function markLanguageAsked(answer: LanguageSetting): void {
  const file = languagePromptFile();
  // writeJson creates only this account's cco folder; the default one may not exist when another account runs.
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { asked: true, answer, at: new Date().toISOString() });
}
