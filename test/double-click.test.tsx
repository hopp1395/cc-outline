import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick, until } from "./helpers/ink.js";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings.js";
import { projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { MouseContext } from "../src/tui/mouse.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { SettingsView } from "../src/tui/SettingsView.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-double-click-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-double-click-"));
  mkdirSync(projectDir(cwd), { recursive: true });
  // Enter only offers sessions whose folder still exists.
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout, { wrap: (e) => <MouseContext.Provider value={true}>{e}</MouseContext.Provider> });

describe("double click", () => {
  it("does what Enter does on a session: asks to continue it", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(projectDir(cwd), "s1.jsonl"),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: ts, cwd, message: { role: "user", content: "Some work" } }) + "\n",
    );
    const view = renderView(<SessionsView cwd={cwd} layout={layout} visible active />);
    await until(() => view.frame().includes("Some work"));
    // The first row of the list, below the top bar.
    await view.click(10, 2);
    await tick();
    expect(view.frame()).not.toContain("Continue this session");
    await view.click(10, 2);
    await until(() => view.frame().includes("Continue this session"));
    expect(view.frame()).toContain("Continue this session where?");
    view.unmount();
  });

  it("does what Enter does on a setting: takes its next value", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await until(() => view.frame().includes("Start"));
    // Row 2 is the Start group's separator, row 3 its first setting.
    await view.click(10, 3);
    await view.click(10, 3);
    await until(() => readSettings().autoOpen !== DEFAULT_SETTINGS.autoOpen);
    expect(readSettings().autoOpen).not.toBe(DEFAULT_SETTINGS.autoOpen);
    view.unmount();
  });
});
