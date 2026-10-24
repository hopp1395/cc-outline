import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { clipboard } from "../src/tui/useClipboard.js";
import { proc } from "../src/proc.js";
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

it("does not open the prompt editor where no Claude Code takes the prompt and the focus", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cco-editor-project-"));
  const view = render(cwd);
  await expect.poll(view.frame).toContain("auto open");
  await view.press("e");
  await expect.poll(view.frame).toContain("e: only in a viewer beside its Claude Code");
  expect(view.frame()).not.toContain("[ Hand over to Claude ]");
  view.unmount();
});

describe("beside a Claude Code in tmux", () => {
  const calls: string[][] = [];
  const realProc = { ...proc };
  const vars = ["TMUX", "TMUX_PANE", "WT_SESSION", "WT_PROFILE_ID"] as const;
  const savedVars: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const v of vars) savedVars[v] = process.env[v];
    for (const v of ["WT_SESSION", "WT_PROFILE_ID"]) delete process.env[v];
    process.env.TMUX = "/tmp/tmux-1/default,1,0";
    process.env.TMUX_PANE = "%2";
    proc.execFile = ((cmd: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
      calls.push([cmd, ...args]);
      done(null, args[0] === "list-panes" ? "4242 %1\n" : "");
    }) as never;
  });
  afterAll(() => {
    Object.assign(proc, realProc);
    for (const v of vars) {
      if (savedVars[v] === undefined) delete process.env[v];
      else process.env[v] = savedVars[v];
    }
  });

  it("says where e works when the focus cannot go back to Claude Code", async () => {
    const pane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    const cwd = mkdtempSync(join(tmpdir(), "cco-editor-project-"));
    const view = renderInk(<App cwd={cwd} claudePid={4242} placement="window" initialMode="settings" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("auto open");
    await view.press("e");
    await expect.poll(view.frame).toContain("e: only beside Claude Code (p: right or left)");
    expect(view.frame()).not.toContain("[ Hand over to Claude ]");
    view.unmount();
    process.env.TMUX_PANE = pane;
  });

  it("types the prompt into Claude Code's prompt line and moves the focus there", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-editor-project-"));
    const view = renderInk(<App cwd={cwd} claudePid={4242} placement="window" initialMode="settings" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("auto open");
    await view.press("e");
    await expect.poll(view.frame).toContain("[ Hand over to Claude ]");
    expect(view.frame()).toContain("Typed into Claude Code's prompt line");
    await view.press("hello Claude");
    await view.press("\u0013");
    await expect.poll(view.frame).toContain("in Claude Code's prompt line: Enter there sends it");
    const typed = calls.findIndex((c) => c.join(" ") === "tmux send-keys -t %1 -l hello Claude");
    expect(typed).toBeGreaterThanOrEqual(0);
    // The window first: the viewer may be in a tmux window of its own.
    expect(calls.slice(typed).map((c) => c.join(" "))).toEqual(expect.arrayContaining(["tmux select-window -t %1", "tmux select-pane -t %1"]));
    expect(copied).not.toContain("hello Claude");
    await expect.poll(() => readDraft(`project-${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`).text).toBe("");
    view.unmount();
  });
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
