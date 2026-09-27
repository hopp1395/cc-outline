import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, settingsFile, subscribeSettings, updateSettings } from "../src/settings.js";
import { nextValue, SETTING_ROWS } from "../src/tui/SettingsView.js";

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
    updateSettings({ showTools: true });
    updateSettings({ wrap: false });
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, showTools: true, wrap: false });
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
    expect(readSettings().autoOpen).toBe("remember");
    writeFileSync(settingsFile(), JSON.stringify({ autoOpen: "always" }));
    expect(readSettings().autoOpen).toBe("always");
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
});
