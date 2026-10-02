import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView, shortValueName } from "../src/tui/SettingsView.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const cwd = join(tmpdir(), "cco-settings-layout-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-settings-layout-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

/** The list column of the Settings view, `listWidth` wide and tall enough for every entry. */
async function listLines(listWidth: number): Promise<string[]> {
  const rows = 60;
  const columns = listWidth + 60;
  const layout: Layout = { columns, rows, listWidth, previewWidth: columns - listWidth - 3, bodyHeight: rows - 4 };
  const app = renderInk(<SettingsView cwd={cwd} layout={layout} active={false} />, layout);
  await expect.poll(app.frame, { timeout: 2000 }).toContain("── Reset");
  app.unmount();
  // Below the top bar, up to the footer; the preview starts two columns after the list.
  return app
    .frame()
    .split("\n")
    .slice(1, rows - 3)
    .map((l) => l.slice(0, listWidth).trimEnd());
}

describe("Settings list", () => {
  it("puts each group under a separator, in order", async () => {
    const lines = await listLines(30);
    const groups = lines.filter((l) => l.startsWith("── ")).map((l) => l.split(" ")[1]);
    expect(groups).toEqual(["Start", "General", "Chat", "Changes", "Plan", "Sessions", "Monitor", "Reset", "Releases"]);
  });

  it("shows every setting's label in full with its value at the right end", async () => {
    const lines = await listLines(30);
    for (const row of SETTING_ROWS) {
      const value = shortValueName(DEFAULT_SETTINGS[row.key]);
      const line = lines.find((l) => l.startsWith(row.label + " ") && l.endsWith(" " + value));
      expect(line, `${row.group}: ${row.label}`).toBeDefined();
      expect(line!.length).toBe(30);
    }
  });

  it("starts each view's group with its tab and ends it with its order", async () => {
    const lines = await listLines(30);
    const chat = lines.slice(lines.findIndex((l) => l.startsWith("── Chat")) + 1);
    expect(chat[0]).toMatch(/^tab +on$/);
    expect(chat[5]).toMatch(/^order +oldest$/);
  });

  it("cuts the label, not the value, when the list is narrow", async () => {
    const lines = await listLines(20);
    const line = lines.find((l) => l.startsWith("remember posit"));
    expect(line).toMatch(/…? on$/);
    expect(line!.length).toBe(20);
  });
});
