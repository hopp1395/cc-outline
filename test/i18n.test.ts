import { afterEach, describe, expect, it } from "vitest";
import { de } from "../src/i18n/de.js";
import { en } from "../src/i18n/en.js";
import { applyLanguage, L, language, languageOf, localeOf, resolveLanguage, systemLocale } from "../src/i18n/index.js";
import { dayLabel } from "../src/tui/days.js";
import { plainMarks, settingLines, settingRows, textOf } from "../src/tui/SettingsView.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const english = systemLocale.get;
afterEach(() => {
  systemLocale.get = english;
  applyLanguage("system");
});

/** The paths of every leaf of a catalog, with what kind it is: a text, a function of n parameters, a list of n. */
function leaves(value: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === "function") out.set(path, `function/${value.length}`);
  else if (Array.isArray(value)) out.set(path, typeof value[0] === "string" || value.length === 0 ? `list/${value.length}` : `list/${value.length}/${typeof value[0]}`);
  else if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) for (const [p, kind] of leaves(v, path ? `${path}.${key}` : key)) out.set(p, kind);
  else out.set(path, typeof value);
  return out;
}

describe("language", () => {
  it("takes the locale from LC_ALL, LC_MESSAGES, LANG, else from Intl", () => {
    const intl = () => "de-DE";
    expect(localeOf({ LANG: "en_US.UTF-8" }, intl)).toBe("en_US.UTF-8");
    expect(localeOf({ LC_ALL: "de_AT.UTF-8", LANG: "en_US.UTF-8" }, intl)).toBe("de_AT.UTF-8");
    expect(localeOf({ LC_MESSAGES: "fr_FR", LANG: "en_US" }, intl)).toBe("fr_FR");
    expect(localeOf({ LANG: "C.UTF-8" }, intl)).toBe("de-DE");
    expect(localeOf({ LC_ALL: "POSIX" }, intl)).toBe("de-DE");
    expect(localeOf({}, intl)).toBe("de-DE");
  });

  it("counts every de locale as German, everything else as English", () => {
    for (const locale of ["de", "de-DE", "de_AT.UTF-8", "de-CH", "DE_de", "de@euro"]) expect(languageOf(locale), locale).toBe("de");
    for (const locale of ["en-US", "fr_FR", "dev", "", "nl-BE"]) expect(languageOf(locale), locale).toBe("en");
  });

  it("follows the system with system, else the language chosen", () => {
    systemLocale.get = () => "de-DE";
    expect(resolveLanguage("system")).toBe("de");
    expect(resolveLanguage("en")).toBe("en");
    systemLocale.get = () => "en-GB";
    expect(resolveLanguage("system")).toBe("en");
    expect(resolveLanguage("de")).toBe("de");
  });

  it("switches the texts with applyLanguage", () => {
    applyLanguage("de");
    expect(language()).toBe("de");
    expect(L().tabs.settings).toBe("Einstellungen");
    applyLanguage("en");
    expect(L().tabs.settings).toBe("Settings");
  });

  it("writes the date separators in the language", () => {
    applyLanguage("de");
    expect(dayLabel("2026-09-28", "always")).toBe("Mo 28. Sep 2026");
    expect(dayLabel("2026-03-01", "always")).toBe("So 1. Mär 2026");
    applyLanguage("en");
    expect(dayLabel("2026-09-28", "always")).toBe("Mon 28 Sep 2026");
  });
});

describe("German texts", () => {
  it("have every text the English ones have, with the same parameters", () => {
    const want = leaves(en);
    const have = leaves(de);
    // The maps of names by value may name more (or fewer) values: English leaves some to their key.
    const maps = /^(settings\.values|dialogs\.avatar\.meanings)\./;
    const missing = [...want].filter(([path, kind]) => !maps.test(path) && have.get(path) !== kind).map(([path, kind]) => `${path} (${kind}, German: ${have.get(path)})`);
    expect(missing).toEqual([]);
  });

  it("are German where the setting rows are", () => {
    applyLanguage("de");
    const rows = settingRows();
    expect(rows.find((r) => r.key === "language")?.label).toBe("Sprache");
    expect(rows.find((r) => r.key === "autoOpen")?.label).toBe("automatisch öffnen");
  });

  it("pair up their backticks in every setting, as the English ones do", () => {
    applyLanguage("de");
    const context = { now: new Date(2026, 8, 30, 15), cwd: "/tmp/my-app" };
    for (const terminal of [undefined, "wt", "tmux"] as const)
      for (const row of settingRows()) {
        const texts = [row.description, ...row.values.map(([, meaning]) => meaning), ...(row.notes ?? []), row.viewKey ?? ""].map((t) => textOf(t, { ...context, terminal }));
        for (const text of texts) expect(text.split("`").length % 2, `${row.key}: ${text}`).toBe(1);
      }
  });

  it("show a setting's details in German, with the default named", () => {
    applyLanguage("de");
    const row = settingRows().find((r) => r.key === "confirmQuit")!;
    const lines = settingLines(row, DEFAULT_SETTINGS.confirmQuit, 200, { now: new Date(), cwd: "/tmp/my-app" }).map((l) => plainMarks(l.replace(/\u001b\[[0-9;]*m/g, "")));
    expect(lines).toContain("Werte");
    expect(lines.some((l) => l.includes("an (Standard)"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Ob "))).toBe(true);
  });
});
