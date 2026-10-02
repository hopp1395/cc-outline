import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isViewShown, nextShownView, rangeStart, readSettings, settingsFile, shownView, subscribeSettings, updateSettings } from "../src/settings.js";
import { isLastView, nextValue, SETTING_ROWS, settingLines } from "../src/tui/SettingsView.js";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-settings-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("settings", () => {
  it("uses the defaults when nothing is stored", () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("stores changes and keeps the other values", () => {
    updateSettings({ showTools: "full" });
    updateSettings({ wrap: false });
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, showTools: "full", wrap: false });
  });

  it("ignores broken files and mistyped values", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ showTools: "yes", wrap: false, extra: 1 }));
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, wrap: false });
    writeFileSync(settingsFile(), "{ not json");
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts only known auto-open values", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ autoOpen: "sometimes" }));
    expect(readSettings().autoOpen).toBe("always");
    writeFileSync(settingsFile(), JSON.stringify({ autoOpen: "never" }));
    expect(readSettings().autoOpen).toBe("never");
  });

  it("keeps the former update check off, and takes the default auto for on", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ updateCheck: false }));
    expect(readSettings().updateMode).toBe("off");
    writeFileSync(settingsFile(), JSON.stringify({ updateCheck: true }));
    expect(readSettings().updateMode).toBe("auto");
    writeFileSync(settingsFile(), JSON.stringify({ updateCheck: false, updateMode: "on" }));
    expect(readSettings().updateMode).toBe("on");
    writeFileSync(settingsFile(), JSON.stringify({ updateMode: "sometimes" }));
    expect(readSettings().updateMode).toBe("auto");
  });

  it("takes over the former pinned group as pinned favorites", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ pinnedGroup: true }));
    expect(readSettings().pinnedFavorites).toBe(true);
    writeFileSync(settingsFile(), JSON.stringify({ pinnedGroup: true, pinnedFavorites: false }));
    expect(readSettings().pinnedFavorites).toBe(false);
    writeFileSync(settingsFile(), JSON.stringify({}));
    expect(readSettings()).toMatchObject({ pinnedFavorites: false, pinnedSessions: true });
  });

  it("accepts only known list orders", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ chatOrder: "newest-first", planOrder: "sideways" }));
    expect(readSettings().chatOrder).toBe("newest-first");
    expect(readSettings().planOrder).toBe("oldest-first");
  });

  it("accepts only known list ranges and ignores the old Sessions and Monitor orders", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ sessionsRange: "90d", monitorRange: "forever", sessionsOrder: "newest-first" }));
    const settings = readSettings();
    expect(settings.sessionsRange).toBe("90d");
    expect(settings.monitorRange).toBe("7d");
    expect("sessionsOrder" in settings).toBe(false);
  });

  it("starts a range at local midnight, today counted", () => {
    const now = new Date(2026, 8, 29, 15, 30);
    expect(rangeStart("today", now)).toBe(new Date(2026, 8, 29).getTime());
    expect(rangeStart("7d", now)).toBe(new Date(2026, 8, 23).getTime());
    expect(rangeStart("30d", now)).toBe(new Date(2026, 7, 31).getTime());
    expect(rangeStart("90d", now)).toBe(new Date(2026, 6, 2).getTime());
    expect(rangeStart("all", now)).toBeUndefined();
  });

  it("reads the old on/off tool setting as a level", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ showTools: true }));
    expect(readSettings().showTools).toBe("compact");
    writeFileSync(settingsFile(), JSON.stringify({ showTools: false }));
    expect(readSettings().showTools).toBe("off");
    writeFileSync(settingsFile(), JSON.stringify({ showTools: "loud" }));
    expect(readSettings().showTools).toBe("off");
  });

  it("accepts only known placements", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ placement: "top" }));
    expect(readSettings().placement).toBe("right");
    writeFileSync(settingsFile(), JSON.stringify({ placement: "window" }));
    expect(readSettings().placement).toBe("window");
  });

  it("tells listeners about changes", () => {
    let calls = 0;
    const unsubscribe = subscribeSettings(() => calls++);
    updateSettings({ marquee: false });
    unsubscribe();
    updateSettings({ marquee: true });
    expect(calls).toBe(1);
  });
});

describe("settings view", () => {
  it("offers every setting once, with its default among the values", () => {
    expect(SETTING_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    for (const row of SETTING_ROWS) expect(row.values.map(([v]) => v)).toContain(DEFAULT_SETTINGS[row.key]);
  });

  it("steps through the values and wraps around", () => {
    const autoOpen = SETTING_ROWS.find((r) => r.key === "autoOpen")!;
    expect(nextValue(autoOpen, "remember")).toBe("always");
    expect(nextValue(autoOpen, "always")).toBe("never");
    expect(nextValue(autoOpen, "never")).toBe("remember");
    const marquee = SETTING_ROWS.find((r) => r.key === "marquee")!;
    expect(nextValue(marquee, true)).toBe(false);
  });

  const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  const details = (key: string, terminal?: "wt" | "tmux") => {
    const row = SETTING_ROWS.find((r) => r.key === key)!;
    return plain(settingLines(row, DEFAULT_SETTINGS[row.key], 2000, { now: new Date(2026, 8, 30, 15), cwd: join(tmpdir(), "my-app"), terminal }));
  };

  it("writes every setting's details in each terminal, without empty notes", () => {
    for (const terminal of ["wt", "tmux", undefined] as const)
      for (const row of SETTING_ROWS) {
        const text = details(row.key, terminal);
        expect(text, row.key).not.toMatch(/undefined|\[object|\n\n\n/);
        for (const [value] of row.values) expect(text, row.key).toContain(`${typeof value === "boolean" ? (value ? "on" : "off") : ""}`);
      }
  });

  it("gives the ranges' first day as an example, counted from today", () => {
    const text = details("sessionsRange");
    expect(text).toContain("only today, since Wed 30 Sep 00:00");
    expect(text).toContain("today and the 6 days before, since Thu 24 Sep 00:00");
    expect(text).toContain("today and the 29 days before, since Tue 1 Sep 00:00");
  });

  it("names this project and the terminal found", () => {
    expect(details("allProjects")).toContain("only this one, my-app");
    expect(details("placement", "wt")).toContain("Alt+Tab");
    expect(details("placement", "tmux")).toContain("tmux window");
    expect(details("placement", "tmux")).not.toContain("Windows Terminal cannot");
    expect(details("mouse", "wt")).toContain("select text with Shift+drag.");
  });
});

describe("hidden views", () => {
  const hide = (...keys: (keyof typeof DEFAULT_SETTINGS)[]) => ({ ...DEFAULT_SETTINGS, ...Object.fromEntries(keys.map((k) => [k, false])) });

  it("never hides Settings, and falls back to the first shown view", () => {
    const settings = hide("viewChat", "viewGit");
    expect(isViewShown(settings, "chat")).toBe(false);
    expect(isViewShown(settings, "settings")).toBe(true);
    expect(shownView(settings, "chat")).toBe("plan");
    expect(shownView(settings, "monitor")).toBe("monitor");
    expect(shownView(hide("viewChat", "viewGit", "viewPlan", "viewSessions", "viewMonitor"), "git")).toBe("settings");
  });

  it("steps through the shown views with Tab and Shift+Tab, wrapping around", () => {
    const settings = hide("viewGit", "viewMonitor");
    expect(nextShownView(settings, "chat", 1)).toBe("plan");
    expect(nextShownView(settings, "sessions", 1)).toBe("settings");
    expect(nextShownView(settings, "settings", 1)).toBe("chat");
    expect(nextShownView(settings, "chat", -1)).toBe("settings");
    // From a hidden view opened by a command, to its shown neighbour.
    expect(nextShownView(settings, "git", 1)).toBe("plan");
  });

  it("keeps the last view besides Settings", () => {
    const one = hide("viewChat", "viewGit", "viewPlan", "viewSessions");
    expect(isLastView(one, "viewMonitor")).toBe(true);
    expect(isLastView(one, "viewChat")).toBe(false);
    expect(isLastView(DEFAULT_SETTINGS, "viewMonitor")).toBe(false);
  });
});

