import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateSettings } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { SettingsView } from "../src/tui/SettingsView.js";

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

function renderView(element: ReactElement) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const app = render(element, { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

describe("restart the viewer", () => {
  it("asks first while confirm quit is on", async () => {
    updateSettings({ confirmQuit: true, rememberPositions: false });
    let restarts = 0;
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:restart", at: 1 }} onRestart={() => restarts++} />);
    await expect.poll(view.frame).toContain("restart the viewer");
    view.press("\r");
    await expect.poll(view.frame).toContain("Restart the viewer?");
    expect(restarts).toBe(0);
    view.press("\r");
    await expect.poll(() => restarts).toBe(1);
    view.unmount();
  });

  it("restarts after a moment in the top bar while confirm quit is off", async () => {
    updateSettings({ confirmQuit: false, rememberPositions: false });
    let restarts = 0;
    let modal = false;
    const view = renderView(
      <SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:restart", at: 1 }} onRestart={() => restarts++} onModal={(m) => (modal = m)} />,
    );
    await expect.poll(view.frame).toContain("restart the viewer");
    view.press("\r");
    await expect.poll(view.frame).toContain("restarting…");
    expect(view.frame()).not.toContain("Restart the viewer?");
    expect(modal).toBe(true);
    await expect.poll(() => restarts, { timeout: 3000 }).toBe(1);
    // A viewer that could not reopen goes on without the badge.
    await expect.poll(view.frame).not.toContain("restarting…");
    await expect.poll(() => modal).toBe(false);
    expect(restarts).toBe(1);
    view.unmount();
  });
});
