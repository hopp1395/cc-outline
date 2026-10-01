import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeDir, projectSlug } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SettingsView } from "../src/tui/SettingsView.js";

const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };
const cwd = join(tmpdir(), "cco-doctor-view-project");
/** Not a multiple of 4, so never a Windows pid. */
const DEAD = 999999;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-doctor-view-"));
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

describe("doctor in the settings", () => {
  it("checks after Enter and a confirmation, then offers the repair and checks again", async () => {
    const stale = join(claudeDir(), "cco", `${projectSlug(cwd)}.claude-${DEAD}.json`);
    mkdirSync(join(claudeDir(), "cco"), { recursive: true });
    writeFileSync(stale, "{}");
    let modal = false;
    const onModal = (m: boolean) => {
      modal = m;
    };
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:doctor", at: 1 }} onModal={onModal} />);
    await expect.poll(view.frame).toContain("✚ Doctor");
    // Nothing is checked before Enter and the confirmation.
    expect(view.frame()).toContain("not checked yet");
    expect(view.frame()).toContain("↵ check");
    view.press("\r");
    await expect.poll(view.frame).toContain("Run the doctor?");
    view.press("\r");
    // Group by group, each after a short pause.
    await expect.poll(view.frame).toContain("Checking Installation…");
    await expect.poll(view.frame).toContain("Checking State files…");
    expect(view.frame()).toMatch(/✗ Installation/);
    expect(view.frame()).toContain("○ Hooks");
    await expect.poll(view.frame, { timeout: 3000 }).toContain("1 state file of processes that have ended");
    expect(view.frame()).toContain("↵ repair");
    view.press("\r");
    await expect.poll(view.frame).toContain("Repair 2 findings?");
    expect(modal).toBe(true);
    view.press("\r");
    await expect.poll(() => existsSync(stale)).toBe(false);
    await expect.poll(view.frame, { timeout: 3000 }).toContain("nothing to clean up");
    expect(view.frame()).toContain("✓ delete 1 state file of ended processes");
    await expect.poll(() => modal, { timeout: 3000 }).toBe(false);
    view.unmount();
  });
});
