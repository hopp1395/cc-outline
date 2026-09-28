import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFavorites } from "../src/favorites.js";
import { readSettings } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView } from "../src/tui/SettingsView.js";

const layout: Layout = { columns: 120, rows: 20, listWidth: 40, previewWidth: 77, bodyHeight: 16 };
const cwd = join(tmpdir(), "cco-settings-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-settings-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

function renderSettings() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 20 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const app = render(<SettingsView cwd={cwd} layout={layout} active />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

describe("SettingsView marks", () => {
  it("marks with Space instead of changing the value, which only Enter does", async () => {
    const view = renderSettings();
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    const before = readSettings()[SETTING_ROWS[0].key];
    view.press(" ");
    await expect.poll(() => readFavorites(cwd, "settings"), { timeout: 2000 }).toEqual([SETTING_ROWS[0].key]);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("★");
    expect(readSettings()[SETTING_ROWS[0].key]).toBe(before);
    view.press("\r");
    await expect.poll(() => readSettings()[SETTING_ROWS[0].key], { timeout: 2000 }).not.toBe(before);
    view.unmount();
  });
});
