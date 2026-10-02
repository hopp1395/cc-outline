import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { claudeDir, claudeFile, projectDir, readJson, viewerFile, writeJson, type ActiveSession } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { Viewer } from "../src/watch.js";
import { detachViewer, pairViewer, registerViewer, runningViewer, unregisterCurrentViewer, type PairTarget } from "../src/viewer.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-pair-project");
const other = join(tmpdir(), "cco-pair-other");

let saved: string | undefined;
let savedTerminal: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-pair-"));
  // A terminal to switch tabs in, as in Windows Terminal; CI has none.
  savedTerminal = { TMUX: process.env.TMUX, WT_SESSION: process.env.WT_SESSION };
  delete process.env.TMUX;
  process.env.WT_SESSION = "x";
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  for (const [key, value] of Object.entries(savedTerminal)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

describe("detachViewer", () => {
  it("moves the registration from the Claude Code process to the project", () => {
    registerViewer(cwd, "chat", process.pid);
    detachViewer(cwd, process.pid, "sessions");
    expect(existsSync(viewerFile(cwd, process.pid))).toBe(false);
    expect(runningViewer(cwd)).toEqual({ pid: process.pid, view: "sessions" });
    unregisterCurrentViewer();
    expect(existsSync(viewerFile(cwd))).toBe(false);
  });
});

const renderView = (onPair?: (t: PairTarget) => boolean) => renderInk(<SessionsView cwd={cwd} layout={layout} visible active onPair={onPair} />, layout);


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
    const app = renderInk(<Viewer cwd={cwd} initialMode="sessions" />, { columns: 160, rows: 24 });
    await until(() => app.frame().includes("↵ attach"));
    await app.press("\r");
    await until(() => app.frame().includes("This session runs in a Claude Code"));
    await app.press("\r");
    await until(() => runningViewer(cwd, process.pid) !== undefined && app.frame().includes("f follow"));
    expect(existsSync(viewerFile(cwd))).toBe(false);
    expect(runningViewer(cwd, process.pid)?.pid).toBe(process.pid);
    expect(app.frame()).toContain("Some work");
    app.unmount();
    unregisterCurrentViewer();
  });
});

describe("pairing in the Sessions view", () => {
  it("pairs a viewer without a Claude Code with a running session, after asking", async () => {
    runningSession("s1");
    const paired: PairTarget[] = [];
    const view = renderView((t) => (paired.push(t), true));
    await until(() => view.frame().includes("↵ attach"));
    expect(view.frame()).toContain("↵ attach");
    await view.press("\r");
    await until(() => view.frame().includes("This session runs in a Claude Code"));
    expect(view.frame()).toContain("it stays here and follows that Claude Code");
    await view.press("\r");
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
    expect(unpairable.frame()).not.toContain("↵ attach");
    unpairable.unmount();
  });
});
