import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick } from "./helpers/ink.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView } from "../src/tui/SettingsView.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-filter-project");
const CTRL_F = "\u0006";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-filter-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout);

/** Types one key at a time; keys written at once would reach one handler before the state it set. */
async function type(view: ReturnType<typeof renderView>, text: string) {
  for (const c of text) {
    await view.press(c);
  }
}

describe("list filter in the settings", () => {
  it("filters while typing, keeps the filter with Enter and drops it with Ctrl+F", async () => {
    let typing = false;
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active onTyping={(t) => (typing = t)} />);
    // Below the settings: the four reset actions and the Releases note (no releases known offline).
    const total = SETTING_ROWS.length + 5;
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Filter");
    expect(typing).toBe(true);
    await type(view, "mouse");
    await expect.poll(view.frame, { timeout: 2000 }).toMatch(new RegExp(`\\d+ of ${total}`));
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    // The list's top row shows the filter, the help line no longer offers it.
    expect(view.frame()).toMatch(new RegExp(`⌕  mouse · \\d+ of ${total} · \\^F clear`));
    expect(view.frame()).not.toContain("^F filter");
    expect(typing).toBe(false);
    expect(view.frame()).toMatch(new RegExp(`\\d+/${total} entries`));
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("⌕");
    expect(view.frame()).toContain("^F filter");
    view.unmount();
  });

  it("shows a hint when nothing matches, and Esc in the dialog drops the filter", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "zzzqqq");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("⌕  zzzqqq");
    expect(view.frame()).toContain("No matches");
    await view.press("\u001b");
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    expect(view.frame()).not.toContain("No matches");
    view.unmount();
  });

  it("shows only the separators of groups with a match", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("⌕  wrap");
    const separators = view.frame().match(/── \w+/g);
    expect(separators).toEqual(["── Chat", "── Changes", "── Plan"]);
    view.unmount();
  });

  it("opens with the filter used last, selected, so typing replaces it", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    expect(view.frame()).toContain("⌕  wrap");
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("⌕  wrap");
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("› wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    expect(view.frame()).toContain("⌕  wrap");
    view.unmount();
  });
});
