import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { accountsHome } from "../src/addAccount.js";
import { applyLanguage, systemLocale } from "../src/i18n/index.js";
import { languagePromptFile, markLanguageAsked, shouldAskLanguage } from "../src/languagePrompt.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 100, rows: 24, listWidth: 30, previewWidth: 67, bodyHeight: 22 };
const english = systemLocale.get;
const home = accountsHome.get;
let saved: string | undefined;

beforeAll(() => {
  accountsHome.get = () => mkdtempSync(join(tmpdir(), "cco-language-home-"));
});
afterAll(() => {
  accountsHome.get = home;
});
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-language-"));
  // A home of its own per test: the question is asked once per machine.
  const own = mkdtempSync(join(tmpdir(), "cco-language-home-"));
  accountsHome.get = () => own;
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  systemLocale.get = english;
  applyLanguage("system");
});

const german = () => (systemLocale.get = () => "de-DE");
const render = (sessionId?: string) =>
  renderInk(<App cwd={mkdtempSync(join(tmpdir(), "cco-language-cwd-"))} sessionId={sessionId} initialMode="settings" />, layout, {
    wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
  });

describe("the language question", () => {
  it("is asked on a German system with no language chosen, once", () => {
    expect(shouldAskLanguage("system")).toBe(false);
    german();
    expect(shouldAskLanguage("system")).toBe(true);
    expect(shouldAskLanguage("en")).toBe(false);
    expect(shouldAskLanguage("de")).toBe(false);
    markLanguageAsked("system");
    expect(shouldAskLanguage("system")).toBe(false);
    expect(existsSync(languagePromptFile())).toBe(true);
  });

  it("keeps German (the system's language) with Yes, and never asks again", async () => {
    german();
    const view = render();
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Ja, Deutsch");
    // Behind it the viewer already speaks the system's language.
    expect(view.frame()).toContain("Einstellungen");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Ja, Deutsch");
    expect(readSettings().language).toBe("system");
    expect(view.frame()).toContain("Einstellungen");
    expect(shouldAskLanguage("system")).toBe(false);
    view.unmount();
  });

  it("switches to English with No, at once", async () => {
    german();
    const view = render();
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Ja, Deutsch");
    await view.press("2");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Settings");
    expect(view.frame()).not.toContain("Einstellungen");
    expect(readSettings().language).toBe("en");
    expect(shouldAskLanguage("system")).toBe(false);
    view.unmount();
  });

  it("takes Esc as No", async () => {
    german();
    const view = render();
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Ja, Deutsch");
    await view.press("\u001b");
    await expect.poll(() => readSettings().language, { timeout: 2000 }).toBe("en");
    view.unmount();
  });

  it("is not asked when a language is chosen, or by a viewer of one session", async () => {
    german();
    updateSettings({ language: "de" });
    const chosen = render();
    await expect.poll(chosen.frame, { timeout: 2000 }).toContain("Einstellungen");
    expect(chosen.frame()).not.toContain("Ja, Deutsch");
    chosen.unmount();
    updateSettings({ language: "system" });
    const observer = render("s1");
    await expect.poll(observer.frame, { timeout: 2000 }).toContain("Chat");
    expect(observer.frame()).not.toContain("Ja, Deutsch");
    observer.unmount();
    rmSync(languagePromptFile(), { force: true });
  });
});

describe("switching the language", () => {
  it("changes every text at once", async () => {
    const view = render();
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Settings");
    updateSettings({ language: "de" });
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Einstellungen");
    expect(view.frame()).toContain("Allgemein");
    updateSettings({ language: "en" });
    await expect.poll(view.frame, { timeout: 2000 }).toContain("General");
    view.unmount();
  });
});
