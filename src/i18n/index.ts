import { de } from "./de.js";
import { en, type Messages } from "./en.js";

/** The languages cco speaks. */
export const LANGUAGES = ["en", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The setting's values: the operating system's language (English unless it is German), or a fixed one. */
export const LANGUAGE_VALUES = ["system", ...LANGUAGES] as const;
export type LanguageSetting = (typeof LANGUAGE_VALUES)[number];

/** Each language's name in itself, as the setting shows it whatever the language. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", de: "Deutsch" };

const CATALOGS: Record<Language, Messages> = { en, de };

/** Where the system's locale comes from; tests swap `get` so they run in English on any machine. */
export const systemLocale = {
  get(): string {
    for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
      const value = process.env[name];
      if (value && value !== "C" && value !== "POSIX" && !value.startsWith("C.")) return value;
    }
    return Intl.DateTimeFormat().resolvedOptions().locale;
  },
};

/** The operating system's language: German for every `de` locale (de-DE, de_AT.UTF-8, de-CH), else English. */
export function systemLanguage(): Language {
  return /^de([-_.@]|$)/i.test(systemLocale.get()) ? "de" : "en";
}

/** The language a setting stands for. */
export function resolveLanguage(setting: LanguageSetting): Language {
  return setting === "system" ? systemLanguage() : setting;
}

let active: Language | undefined;

/** Switches the texts to the language `setting` stands for (the viewer on each change, the CLI at its start). */
export function applyLanguage(setting: LanguageSetting): void {
  active = resolveLanguage(setting);
}

/** The language texts are written in now: the one applied last, else the system's. */
export function language(): Language {
  return (active ??= systemLanguage());
}

/** The texts in the current language. */
export function L(): Messages {
  return CATALOGS[language()];
}

/** The texts of a language, e.g. the language dialog's line in English. */
export function messagesOf(lang: Language): Messages {
  return CATALOGS[lang];
}

/** `one` or `other` for `n`, the way both languages count: 1 is singular, everything else plural. */
export const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);
