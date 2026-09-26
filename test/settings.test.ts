import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, settingsFile, updateSettings } from "../src/settings.js";

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
});
