import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/hook.js";
import { detectTerminal } from "../src/open.js";
import { findLatestTranscript, projectDir, readActive, viewerFile, writeJson } from "../src/transcript/locate.js";
import { readControl, registerViewer, requestView, runningViewer, setViewerView, unregisterViewer } from "../src/viewer.js";

const cwd = join(tmpdir(), "cco-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-config-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const hook = (event: string, session: string, reason?: string) =>
  handleHook({ hook_event_name: event, session_id: session, transcript_path: `/t/${session}.jsonl`, cwd, reason });

describe("handleHook", () => {
  it("records the active session and marks it ended on exit", () => {
    hook("SessionStart", "a");
    expect(readActive(cwd)).toMatchObject({ session_id: "a", transcript_path: "/t/a.jsonl" });
    expect(readActive(cwd)?.ended).toBeUndefined();
    hook("SessionEnd", "a", "prompt_input_exit");
    expect(readActive(cwd)).toMatchObject({ session_id: "a", ended: true });
  });

  it("ignores /clear and ends of sessions that are no longer active", () => {
    hook("SessionStart", "a");
    hook("SessionEnd", "a", "clear");
    expect(readActive(cwd)?.ended).toBeUndefined();
    hook("SessionStart", "b");
    hook("SessionEnd", "a", "other");
    expect(readActive(cwd)).toMatchObject({ session_id: "b" });
    expect(readActive(cwd)?.ended).toBeUndefined();
  });

  it("a new session start clears the ended flag", () => {
    hook("SessionStart", "a");
    hook("SessionEnd", "a", "other");
    hook("SessionStart", "a");
    expect(readActive(cwd)?.ended).toBeUndefined();
  });
});

describe("findLatestTranscript", () => {
  it("skips newer bookkeeping files without messages", () => {
    const dir = projectDir(cwd);
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "real.jsonl");
    const stub = join(dir, "stub.jsonl");
    writeFileSync(real, '{"type":"user","message":{"content":"hi"}}\n');
    writeFileSync(stub, '{"type":"bridge-session","sessionId":"x"}\n');
    utimesSync(real, new Date(1000), new Date(1000));
    expect(findLatestTranscript(cwd)).toBe(real);
  });
});

describe("viewer registration", () => {
  it("reports the running viewer and forgets dead ones", () => {
    expect(runningViewer(cwd)).toBeUndefined();
    registerViewer(cwd, "chat");
    expect(runningViewer(cwd)).toEqual({ pid: process.pid, view: "chat" });
    setViewerView(cwd, "git");
    expect(runningViewer(cwd)?.view).toBe("git");
    unregisterViewer(cwd);
    expect(runningViewer(cwd)).toBeUndefined();
    writeJson(viewerFile(cwd), { pid: 2 ** 22 + 12345 });
    expect(runningViewer(cwd)).toBeUndefined();
  });

  it("passes view requests through the control file", () => {
    const before = Date.now();
    requestView(cwd, "git");
    const req = readControl(cwd);
    expect(req?.view).toBe("git");
    expect(req!.at).toBeGreaterThanOrEqual(before);
  });
});

describe("restore on restart", () => {
  const opened: string[] = [];
  const fakeOpen = (_cwd: string, view: string, opts?: { keepFocus?: boolean }) => {
    opened.push(`${view}${opts?.keepFocus ? " keepFocus" : ""}`);
    return "";
  };
  const run = (event: string, extra: { reason?: string; source?: string } = {}) =>
    handleHook(
      { hook_event_name: event, session_id: "a", transcript_path: "/t/a.jsonl", cwd, ...extra },
      fakeOpen as never,
    );
  beforeEach(() => {
    opened.length = 0;
  });

  it("reopens the viewer with its last view when it was open at exit", () => {
    run("SessionStart", { source: "startup" });
    registerViewer(cwd, "git");
    run("SessionEnd", { reason: "prompt_input_exit" });
    unregisterViewer(cwd); // the viewer closes itself after the session ended
    run("SessionStart", { source: "startup" });
    expect(opened).toEqual(["git keepFocus"]);
  });

  it("stays closed when the viewer was closed at exit", () => {
    run("SessionStart", { source: "startup" });
    run("SessionEnd", { reason: "prompt_input_exit" });
    run("SessionStart", { source: "resume" });
    expect(opened).toEqual([]);
  });

  it("does not open a second viewer or react to /clear and compaction", () => {
    registerViewer(cwd, "chat");
    run("SessionStart", { source: "startup" });
    run("SessionEnd", { reason: "other" });
    run("SessionStart", { source: "startup" }); // quick restart: viewer still running
    unregisterViewer(cwd);
    run("SessionStart", { source: "clear" });
    run("SessionStart", { source: "compact" });
    expect(opened).toEqual([]);
  });
});

describe("detectTerminal", () => {
  it("recognises tmux and Windows Terminal, also without WT_SESSION", () => {
    expect(detectTerminal({ TMUX: "/tmp/tmux-1/default,1,0" })).toBe("tmux");
    expect(detectTerminal({ WT_SESSION: "abc" })).toBe("wt");
    expect(detectTerminal({ WT_PROFILE_ID: "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}" })).toBe("wt");
    expect(detectTerminal({})).toBeUndefined();
  });
});
