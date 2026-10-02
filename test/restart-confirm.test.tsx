import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { updateSettings } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { App } from "../src/tui/App.js";
import { SettingsView } from "../src/tui/SettingsView.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };
const cwd = join(tmpdir(), "cco-restart-confirm-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-restart-confirm-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });

describe("restart the viewer", () => {
  it("asks first while confirm quit is on", async () => {
    updateSettings({ confirmQuit: true, rememberPositions: false });
    let restarts = 0;
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:restart", at: 1 }} onRestart={() => restarts++} />);
    await expect.poll(view.frame).toContain("restart the viewer");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Restart the viewer?");
    expect(restarts).toBe(0);
    await view.press("\r");
    await expect.poll(() => restarts).toBe(1);
    view.unmount();
  });

  it("restarts without asking while confirm quit is off", async () => {
    updateSettings({ confirmQuit: false, rememberPositions: false });
    let restarts = 0;
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:restart", at: 1 }} onRestart={() => restarts++} />);
    await expect.poll(view.frame).toContain("restart the viewer");
    await view.press("\r");
    await expect.poll(() => restarts).toBe(1);
    expect(view.frame()).not.toContain("Restart the viewer?");
    view.unmount();
  });

  it("shows the restart in the progress dialog, and says when the viewer cannot reopen", async () => {
    updateSettings({ confirmQuit: false, rememberPositions: false });
    // No terminal to reopen in: cco open is not started.
    const env = { TMUX: process.env.TMUX, WT_SESSION: process.env.WT_SESSION, WT_PROFILE_ID: process.env.WT_PROFILE_ID };
    for (const key of Object.keys(env)) delete process.env[key];
    try {
      const view = renderView(<App cwd={mkdtempSync(join(tmpdir(), "cco-restart-app-"))} initialMode="settings" select="reset:restart" />);
      await expect.poll(view.frame).toContain("restart the viewer");
      await view.press("\r");
      await expect.poll(view.frame).toContain("Restarting…");
      expect(view.frame()).toContain("cannot be cancelled");
      await expect.poll(view.frame, { timeout: 3000 }).toContain("✗ The viewer did not reopen");
      expect(view.frame()).toContain("cannot reopen itself here: close it with q");
      await view.press("\u001b");
      await expect.poll(view.frame).not.toContain("did not reopen");
      view.unmount();
    } finally {
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    }
  });
});
