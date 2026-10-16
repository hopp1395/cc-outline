import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { diagnoseGroup } from "../src/doctor.js";
import { readFavorites } from "../src/favorites.js";
import {
  DEFAULT_SETTINGS,
  isViewShown,
  readMainSettings,
  readSettings,
  resetSessionViewerSettings,
  SESSION_VIEWER_KEYS,
  sessionViewerSettingsFile,
  setSessionViewer,
  settingsFile,
  updateSettings,
} from "../src/settings.js";
import { projectDir } from "../src/transcript/locate.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { SESSION_RESET_ACTIONS, SETTING_ROWS, SettingsView, settingsEntries } from "../src/tui/SettingsView.js";
import type { Update } from "../src/tui/useUpdate.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-session-viewer-settings");
const stored = (file: string) => JSON.parse(readFileSync(file, "utf8"));

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-session-viewer-settings-"));
});
afterEach(() => {
  setSessionViewer(false);
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("the settings of a viewer of one session", () => {
  it("take the project's viewer's values at the first start, then stay apart from them", () => {
    updateSettings({ showTools: "full", chatWrap: false, remoteControl: true });
    setSessionViewer(true);
    expect(readSettings()).toMatchObject({ showTools: "full", chatWrap: false, remoteControl: true });
    expect(stored(sessionViewerSettingsFile())).toEqual(expect.objectContaining({ showTools: "full", chatWrap: false }));
    expect(stored(sessionViewerSettingsFile())).not.toHaveProperty("remoteControl");

    // Its own keys go to its own file, the rest to the project's viewer's.
    updateSettings({ showTools: "off", remoteApi: true });
    expect(readSettings()).toMatchObject({ showTools: "off", remoteApi: true });
    expect(readMainSettings()).toMatchObject({ showTools: "full", remoteApi: true });

    // A change in the project's viewer does not reach it.
    setSessionViewer(false);
    updateSettings({ chatWrap: true, showThinking: true });
    setSessionViewer(true);
    expect(readSettings()).toMatchObject({ showTools: "off", chatWrap: false, showThinking: false });
  });

  it("go back to the defaults or take the project's viewer's values again", () => {
    updateSettings({ showTools: "full" });
    setSessionViewer(true);
    updateSettings({ mouse: false });
    resetSessionViewerSettings("defaults");
    expect(readSettings()).toMatchObject({ showTools: DEFAULT_SETTINGS.showTools, mouse: true });
    resetSessionViewerSettings("main");
    expect(readSettings().showTools).toBe("full");
    expect(readMainSettings().mouse).toBe(true);
  });

  it("fall back to the default for a mistyped value and keep a newer version's keys", () => {
    mkdirSync(dirname(sessionViewerSettingsFile()), { recursive: true });
    writeFileSync(sessionViewerSettingsFile(), JSON.stringify({ showTools: "loud", futureSetting: 1 }));
    setSessionViewer(true);
    expect(readSettings().showTools).toBe(DEFAULT_SETTINGS.showTools);
    updateSettings({ chatWrap: false });
    expect(stored(sessionViewerSettingsFile())).toMatchObject({ futureSetting: 1, chatWrap: false });
  });

  it("are not created by the project's viewer", () => {
    updateSettings({ showTools: "full" });
    readSettings();
    expect(existsSync(sessionViewerSettingsFile())).toBe(false);
    expect(stored(settingsFile()).showTools).toBe("full");
  });

  it("show only the chat and the settings", () => {
    setSessionViewer(true);
    const settings = readSettings();
    expect(isViewShown(settings, "settings")).toBe(true);
    expect(isViewShown(settings, "sessions")).toBe(false);
  });
});

describe("the Settings view of a viewer of one session", () => {
  const update = { releases: [], state: { kind: "none" }, run: undefined } as unknown as Update;

  it("lists its own settings and their two resets", () => {
    const entries = settingsEntries(update, undefined, true);
    const keys = entries.flatMap((e) => ("key" in e ? [e.key] : []));
    expect(keys.sort()).toEqual([...SESSION_VIEWER_KEYS].sort());
    expect(entries.filter((e) => "id" in e)).toEqual(SESSION_RESET_ACTIONS);
    // Every key has its row.
    expect(SESSION_VIEWER_KEYS.every((k) => SETTING_ROWS.some((r) => r.key === k))).toBe(true);
  });

  it("changes, marks and resets them apart from the project's viewer", async () => {
    setSessionViewer(true);
    const view = renderInk(<SettingsView cwd={cwd} layout={layout} active oneSession />, layout);
    await until(() => view.frame().includes("confirm quit"));
    expect(view.frame()).not.toContain("auto open");
    expect(view.frame()).toContain("settings.session-viewer.json");
    await view.press("\r");
    await expect.poll(() => readSettings().confirmQuit).toBe(false);
    expect(readMainSettings().confirmQuit).toBe(true);
    await view.press(" ");
    await expect.poll(() => readFavorites(cwd, "sessionViewerSettings")).toEqual(["confirmQuit"]);
    expect(readFavorites(cwd, "settings")).toEqual([]);
    // The last entry: the project's viewer's values, asked first.
    await view.press("\u001b[F");
    await until(() => view.frame().includes("1 different"));
    await view.press("\r");
    await until(() => view.frame().includes("Take the settings of the project's viewer?"));
    await view.press("\r");
    await expect.poll(() => readSettings().confirmQuit).toBe(true);
    view.unmount();
  });
});

describe("the doctor", () => {
  it("checks the file of the viewers of one session like settings.json", () => {
    mkdirSync(dirname(sessionViewerSettingsFile()), { recursive: true });
    writeFileSync(sessionViewerSettingsFile(), JSON.stringify({ mouse: "yes", autoOpen: "never" }));
    const texts = diagnoseGroup("Settings", { cwd }).map((f) => f.text);
    expect(texts).toEqual(expect.arrayContaining(['mouse: "yes" is not valid; the default true applies', "unknown setting autoOpen in settings.session-viewer.json"]));
  });
});

describe("a viewer of one session", () => {
  beforeEach(() => setSessionViewer(true));

  it("switches to its settings with 6 and back with 1", async () => {
    mkdirSync(projectDir(cwd), { recursive: true });
    const prompt = { type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "watch me work" } };
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), JSON.stringify(prompt) + "\n");
    const app = renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("watch me work"));
    await app.press("6");
    await until(() => app.frame().includes("confirm quit"));
    expect(app.frame()).not.toContain("auto open");
    await app.press("1");
    await until(() => !app.frame().includes("confirm quit"));
    expect(app.frame()).toContain("watch me work");
    app.unmount();
  });
});
