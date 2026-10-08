import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { updateSettings } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { App } from "../src/tui/App.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-view-arrows-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("← and → in the viewer", () => {
  const layout: Layout = { columns: 140, rows: 30, listWidth: 40, previewWidth: 97, bodyHeight: 26 };

  it("switch to the previous and next shown view, wrapping around", async () => {
    updateSettings({ viewMonitor: false });
    const view = renderInk(<App cwd={mkdtempSync(join(tmpdir(), "cco-view-arrows-app-"))} sessionId="none" initialMode="settings" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("auto open");
    // Past the last view comes the first.
    await view.press("\u001b[C");
    await expect.poll(view.frame).toContain("Waiting for prompts");
    await view.press("\u001b[D");
    await expect.poll(view.frame).toContain("auto open");
    // The hidden Monitor is skipped.
    await view.press("\u001b[D");
    await expect.poll(view.frame).toContain("import sessions…");
    // Ctrl+← scrolls sideways in the views and leaves the view alone.
    await view.press("\u001b[1;5D");
    await view.press("\u001b[C");
    await expect.poll(view.frame).toContain("auto open");
    view.unmount();
  });
});
