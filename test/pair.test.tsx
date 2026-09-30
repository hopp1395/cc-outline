import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeDir, claudeFile, projectDir, readJson, viewerFile, writeJson, type ActiveSession } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { Viewer } from "../src/watch.js";
import { pairViewer, registerViewer, runningViewer, unregisterCurrentViewer, type PairTarget } from "../src/viewer.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-pair-project");
const other = join(tmpdir(), "cco-pair-other");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-pair-"));
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const target = (over: Partial<PairTarget> = {}): PairTarget => ({ cwd: other, claudePid: process.pid, sessionId: "s1", transcript: "/t/s1.jsonl", ...over });

describe("pairViewer", () => {
  it("moves the registration to the Claude Code process and names its session", () => {
    registerViewer(cwd, "sessions");
    expect(pairViewer({ cwd }, target())).toBe(true);
    expect(existsSync(viewerFile(cwd))).toBe(false);
    expect(runningViewer(other, process.pid)).toEqual({ pid: process.pid, view: "chat" });
    expect(readJson<ActiveSession>(claudeFile(other, process.pid))).toMatchObject({ session_id: "s1", transcript_path: "/t/s1.jsonl", cwd: other });
    // On exit, the registration made last goes.
    unregisterCurrentViewer();
    expect(existsSync(viewerFile(other, process.pid))).toBe(false);
  });

  it("keeps the session file the hooks wrote", () => {
    writeJson(claudeFile(other, process.pid), { session_id: "s2", transcript_path: "/t/s2.jsonl", cwd: other, updated: "x" });
    expect(pairViewer({ cwd }, target())).toBe(true);
    expect(readJson<ActiveSession>(claudeFile(other, process.pid))?.session_id).toBe("s2");
    unregisterCurrentViewer();
  });

  it("refuses a process that has a viewer already", () => {
    registerViewer(cwd, "sessions");
    writeJson(viewerFile(other, process.pid), { pid: process.pid, view: "git" });
    expect(pairViewer({ cwd }, target())).toBe(false);
    expect(existsSync(viewerFile(cwd))).toBe(true);
    unregisterCurrentViewer();
  });
});

function renderView(onPair?: (t: PairTarget) => boolean) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const app = render(<SessionsView cwd={cwd} layout={layout} visible active onPair={onPair} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
}

/** A session of the project, run by this process as its Claude Code. */
function runningSession(id: string) {
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(projectDir(cwd), `${id}.jsonl`), JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: "Some work" } }) + "\n");
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status: "idle" }));
}

describe("pairing the viewer", () => {
  it("follows the paired session in the chat and moves its registration there", async () => {
    runningSession("s1");
    registerViewer(cwd, "sessions");
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
    let frame = "";
    stdout.on("data", (chunk) => {
      const text = stripAnsi(String(chunk));
      if (text.trim()) frame = text;
    });
    const app = render(<Viewer cwd={cwd} initialMode="sessions" />, { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
    await until(() => frame.includes("↵ pair"));
    stdin.write("\r");
    await until(() => frame.includes("Pair the viewer with this session?"));
    stdin.write("\r");
    await until(() => runningViewer(cwd, process.pid) !== undefined && frame.includes("f follow"));
    expect(existsSync(viewerFile(cwd))).toBe(false);
    expect(runningViewer(cwd, process.pid)?.pid).toBe(process.pid);
    expect(frame).toContain("Some work");
    app.unmount();
    unregisterCurrentViewer();
  });
});

describe("pairing in the Sessions view", () => {
  it("pairs a viewer without a Claude Code with a running session, after asking", async () => {
    runningSession("s1");
    const paired: PairTarget[] = [];
    const view = renderView((t) => (paired.push(t), true));
    await until(() => view.frame().includes("↵ pair"));
    expect(view.frame()).toContain("↵ pair");
    view.press("\r");
    await until(() => view.frame().includes("Pair the viewer with this session?"));
    expect(view.frame()).toContain("it closes when that Claude Code ends.");
    view.press("\r");
    await until(() => paired.length > 0);
    expect(paired).toEqual([{ cwd, claudePid: process.pid, sessionId: "s1", transcript: join(projectDir(cwd), "s1.jsonl") }]);
    view.unmount();
  });

  it("switches instead when that Claude Code has a viewer, or this viewer has a Claude Code", async () => {
    runningSession("s1");
    writeJson(viewerFile(cwd, process.pid), { pid: process.pid, view: "chat" });
    const view = renderView(() => true);
    await until(() => view.frame().includes("↵ switch"));
    expect(view.frame()).toContain("↵ switch");
    view.unmount();
    const unpairable = renderView();
    await until(() => unpairable.frame().includes("↵ switch"));
    expect(unpairable.frame()).not.toContain("↵ pair");
    unpairable.unmount();
  });
});
