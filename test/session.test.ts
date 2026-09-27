import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/hook.js";
import { saveSessionPlacement, saveSessionView } from "../src/sessionViews.js";
import { updateSettings } from "../src/settings.js";
import { detectTerminal } from "../src/open.js";
import {
  claudeFile,
  claudePidFromEnv,
  findLatestTranscript,
  projectDir,
  readActive,
  readJson,
  viewerFile,
  writeJson,
  type ActiveSession,
} from "../src/transcript/locate.js";
import {
  anyRunningViewer,
  readControl,
  readRestore,
  registerViewer,
  requestView,
  runningViewer,
  setViewerView,
  unregisterViewer,
} from "../src/viewer.js";

const cwd = join(tmpdir(), "cco-project");
let saved: string | undefined;
let savedPid: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  savedPid = process.env.CLAUDE_PID;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-config-"));
  // The tests may run under Claude Code, which sets it; each test decides.
  delete process.env.CLAUDE_PID;
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  if (savedPid === undefined) delete process.env.CLAUDE_PID;
  else process.env.CLAUDE_PID = savedPid;
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

describe("sessions per Claude Code process", () => {
  // Two Claude Code processes in the same project; ours is process.pid so it counts as alive.
  const mine = process.pid;
  const other = process.ppid;
  const hookOf = (pid: number, event: string, session: string, extra: { reason?: string; source?: string } = {}) =>
    handleHook(
      { hook_event_name: event, session_id: session, transcript_path: `/t/${session}.jsonl`, cwd, ...extra },
      (() => "") as never,
      pid,
    );
  const own = (pid: number) => readJson<ActiveSession>(claudeFile(cwd, pid));

  it("keeps each process's session apart from the project's active one", () => {
    hookOf(mine, "SessionStart", "a");
    hookOf(other, "SessionStart", "b");
    expect(readActive(cwd)?.session_id).toBe("b");
    expect(own(mine)?.session_id).toBe("a");
    expect(own(other)?.session_id).toBe("b");
  });

  it("ending the other session does not end ours", () => {
    hookOf(mine, "SessionStart", "a");
    hookOf(other, "SessionStart", "b", { source: "resume" });
    hookOf(other, "SessionEnd", "b", { reason: "prompt_input_exit" });
    expect(own(other)?.ended).toBe(true);
    expect(own(mine)?.ended).toBeUndefined();
  });

  it("follows /clear within the same process", () => {
    hookOf(mine, "SessionStart", "a");
    hookOf(mine, "SessionEnd", "a", { reason: "clear" });
    hookOf(mine, "SessionStart", "c", { source: "clear" });
    expect(own(mine)).toMatchObject({ session_id: "c" });
    expect(own(mine)?.ended).toBeUndefined();
  });

  it("registers viewers and view requests per process", () => {
    registerViewer(cwd, "plan", mine);
    expect(runningViewer(cwd, mine)?.view).toBe("plan");
    expect(runningViewer(cwd, other)).toBeUndefined();
    expect(runningViewer(cwd)).toBeUndefined();
    expect(anyRunningViewer(cwd)).toBe(true);
    requestView(cwd, "git", mine);
    expect(readControl(cwd, mine)?.view).toBe("git");
    expect(readControl(cwd, other)).toBeUndefined();
  });

  it("a session without its own viewer leaves the restore state alone while another viewer runs", () => {
    registerViewer(cwd, "sessions", mine);
    hookOf(mine, "SessionStart", "a");
    hookOf(mine, "SessionEnd", "a", { reason: "other" });
    expect(readRestore(cwd)).toEqual({ open: true, view: "sessions" });
    hookOf(other, "SessionStart", "b", { source: "resume" });
    hookOf(other, "SessionEnd", "b", { reason: "other" });
    expect(readRestore(cwd)).toEqual({ open: true, view: "sessions" });
  });

  it("does not open a viewer for a second session while one runs in the project", () => {
    const opened: string[] = [];
    registerViewer(cwd, "chat", mine);
    handleHook(
      { hook_event_name: "SessionEnd", session_id: "a", transcript_path: "/t/a.jsonl", cwd, reason: "other" },
      (() => "") as never,
      mine,
    );
    handleHook(
      { hook_event_name: "SessionStart", session_id: "b", transcript_path: "/t/b.jsonl", cwd, source: "resume" },
      ((_c: string, view: string) => (opened.push(view), "")) as never,
      other,
    );
    expect(opened).toEqual([]);
  });

  it("reads the Claude Code pid from the environment", () => {
    expect(claudePidFromEnv({ CLAUDE_PID: "28244" })).toBe(28244);
    expect(claudePidFromEnv({ CLAUDE_PID: "" })).toBeUndefined();
    expect(claudePidFromEnv({})).toBeUndefined();
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

  it("always: opens in a project it never ran in, with the chat or the view shown last", () => {
    updateSettings({ autoOpen: "always" });
    run("SessionStart", { source: "startup" });
    unregisterViewer(cwd);
    run("SessionEnd", { reason: "prompt_input_exit" }); // closed at exit
    run("SessionStart", { source: "resume" });
    unregisterViewer(cwd);
    registerViewer(cwd, "plan");
    run("SessionEnd", { reason: "prompt_input_exit" });
    unregisterViewer(cwd);
    run("SessionStart", { source: "startup" });
    expect(opened).toEqual(["chat keepFocus", "chat keepFocus", "plan keepFocus"]);
  });

  it("always: still no second viewer", () => {
    updateSettings({ autoOpen: "always" });
    registerViewer(cwd, "chat");
    run("SessionStart", { source: "startup" });
    expect(opened).toEqual([]);
  });

  it("reopens a resumed session in its own last view, unless switched off", () => {
    run("SessionStart", { source: "startup" });
    registerViewer(cwd, "git");
    run("SessionEnd", { reason: "prompt_input_exit" });
    unregisterViewer(cwd);
    saveSessionView(cwd, "a", "plan");
    run("SessionStart", { source: "resume" });
    unregisterViewer(cwd);
    updateSettings({ rememberView: false });
    run("SessionStart", { source: "resume" });
    expect(opened).toEqual(["plan keepFocus", "git keepFocus"]);
  });

  it("opens where the session was moved with p, else as the setting says", () => {
    const placed: string[] = [];
    const openAt = (_cwd: string, _view: string, opts?: { placement?: string }) => (placed.push(opts?.placement ?? "?"), "");
    const start = () =>
      handleHook({ hook_event_name: "SessionStart", session_id: "a", transcript_path: "/t/a.jsonl", cwd, source: "resume" }, openAt as never);
    updateSettings({ autoOpen: "always", placement: "left" });
    start();
    saveSessionPlacement(cwd, "a", "window");
    start();
    expect(placed).toEqual(["left", "window"]);
  });

  it("never: stays closed even if it was open at exit", () => {
    updateSettings({ autoOpen: "never" });
    registerViewer(cwd, "git");
    run("SessionEnd", { reason: "prompt_input_exit" });
    unregisterViewer(cwd);
    run("SessionStart", { source: "startup" });
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
