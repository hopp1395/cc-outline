import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { clipboard } from "../src/tui/useClipboard.js";
import { readDraft } from "../src/promptDraft.js";
import { readReply } from "../src/promptEdit.js";
import { requestEdit } from "../src/viewer.js";

const copied: string[] = [];
const real = { ...clipboard };
beforeAll(() => {
  clipboard.copy = async (text: string) => {
    copied.push(text);
  };
});
afterAll(() => {
  Object.assign(clipboard, real);
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-editor-app-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const render = (cwd: string) =>
  renderInk(<App cwd={cwd} initialMode="settings" />, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });

it("opens the prompt editor with e and copies the prompt where no Claude Code takes it, keeping the draft", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cco-editor-project-"));
  const view = render(cwd);
  await expect.poll(view.frame).toContain("auto open");
  await view.press("e");
  await expect.poll(view.frame).toContain("[ Hand over to Claude ]");
  expect(view.frame()).toContain("Copied when handed over");
  await view.press("hello Claude");
  await view.press("\u0013");
  await expect.poll(() => copied.at(-1)).toBe("hello Claude");
  await expect.poll(view.frame).toContain("copied, paste it into Claude Code");
  expect(view.frame()).not.toContain("[ Hand over to Claude ]");
  await expect.poll(() => readDraft(`project-${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`).text).toBe("hello Claude");
  view.unmount();
});

it("declines Ctrl+G when it follows no Claude Code, so cco edit edits in Claude Code's pane", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cco-editor-project-"));
  const file = join(mkdtempSync(join(tmpdir(), "cco-editor-file-")), "prompt.md");
  writeFileSync(file, "");
  const view = render(cwd);
  await expect.poll(view.frame).toContain("auto open");
  requestEdit(cwd, 4242, { file, pid: process.pid });
  // The viewer without a Claude Code does not watch that process's control file: no answer, cco edit's wait runs out.
  await new Promise((r) => setTimeout(r, 100));
  expect(readReply(file)).toBeUndefined();
  expect(view.frame()).not.toContain("[ Hand over to Claude ]");
  view.unmount();
});
