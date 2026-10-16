import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick, until } from "./helpers/ink.js";
import { stripVTControlCharacters } from "node:util";
import { TIMING } from "../src/timing.js";
import { formatAge, rcViewerEntries, rcViewerState, nextWaiting, runningStandIn, updateFresh, type FreshIdle, type RcViewerEntry, type SeenStates } from "../src/rcViewer/state.js";
import { registerRcViewer, runningRcViewer, rcViewerFile } from "../src/rcViewer/registry.js";
import { openRcViewer } from "../src/open.js";
import { DEFAULT_SETTINGS, isViewShown, RC_VIEWER_KEYS, rcViewerSettingsFile, readMainSettings, readSettings, setOwnSettings, updateSettings } from "../src/settings.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import type { RunningSession } from "../src/transcript/trash.js";
import { RcViewerApp } from "../src/tui/RcViewerApp.js";
import { matchesRequest } from "../src/tui/RcViewerView.js";
import { rcViewerOptions, type RcViewerSituation } from "../src/rcViewer/actions.js";
import { rcViewerRowLabel, SessionsView } from "../src/tui/SessionsView.js";
import { proc } from "../src/proc.js";
import { remote } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { readRcViewerRequest } from "../src/rcViewer/registry.js";
import { rcViewerLayout } from "../src/tui/layout.js";
import { RC_VIEWER_RESET_ACTIONS, RC_VIEWER_ROWS, settingsEntries } from "../src/tui/SettingsView.js";
import type { Update } from "../src/tui/useUpdate.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DAY_START = Date.parse("2026-10-16T00:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const summary = (id: string, minutesAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  path: `/p/${id}.jsonl`,
  prompts: [{ text: `work ${id}` }],
  plans: [],
  files: [],
  modified: at(minutesAgo),
  ...extra,
});
const run = (activity?: RunningSession["activity"]): RunningSession => ({ pid: 1, activity });

describe("Remote Control Viewer state", () => {
  it("tells waiting, working, idle and ended apart, for this machine's sessions and remote ones", () => {
    expect(rcViewerState(summary("a", 1), run("waiting"))).toBe("waiting");
    expect(rcViewerState(summary("a", 1), run("busy"))).toBe("busy");
    expect(rcViewerState(summary("a", 1), run("idle"))).toBe("idle");
    // Before Claude Code wrote a status, a running session counts as idle.
    expect(rcViewerState(summary("a", 1), run())).toBe("idle");
    expect(rcViewerState(summary("a", 1))).toBe("ended");
    const remote = (workerStatus: string, connectionStatus = "connected") => summary("r", 1, { remote: { loaded: false, workerStatus, connectionStatus } });
    expect(rcViewerState(remote("requires_action"))).toBe("waiting");
    expect(rcViewerState(remote("running"))).toBe("busy");
    expect(rcViewerState(remote("idle"))).toBe("idle");
    expect(rcViewerState(remote("idle", "disconnected"))).toBe("ended");
  });

  it("lists what runs and what ran today, waiting first (the longest waiting on top), the others newest first", () => {
    const sessions = [
      summary("old", 60 * 24),
      summary("ended", 30),
      summary("idle-old", 50),
      summary("idle-new", 5),
      summary("busy", 40),
      summary("wait-new", 2),
      summary("wait-old", 20),
      summary("running-yesterday", 60 * 30),
    ];
    const running = new Map([
      ["idle-old", run("idle")],
      ["idle-new", run("idle")],
      ["busy", run("busy")],
      ["wait-new", run("waiting")],
      ["wait-old", run("waiting")],
      ["running-yesterday", run("idle")],
    ]);
    const seen: SeenStates = new Map();
    const entries = rcViewerEntries(sessions, running, (s) => s.id, seen, NOW, DAY_START);
    expect(entries.map((e) => `${e.state}:${e.key}`)).toEqual([
      "waiting:wait-old",
      "waiting:wait-new",
      "busy:busy",
      "idle:idle-new",
      "idle:idle-old",
      "idle:running-yesterday",
      "ended:ended",
    ]);
    // First seen: since its last write.
    expect(entries.find((e) => e.key === "wait-old")!.since).toBe(NOW - 20 * 60_000);
  });

  it("keeps since when a session is in its state, and starts anew when it changes", () => {
    const seen: SeenStates = new Map();
    const sessions = [summary("a", 10)];
    rcViewerEntries(sessions, new Map([["a", run("busy")]]), (s) => s.id, seen, NOW, DAY_START);
    const later = NOW + 60_000;
    expect(rcViewerEntries(sessions, new Map([["a", run("busy")]]), (s) => s.id, seen, later, DAY_START)[0]!.since).toBe(NOW - 10 * 60_000);
    expect(rcViewerEntries(sessions, new Map([["a", run("waiting")]]), (s) => s.id, seen, later, DAY_START)[0]!.since).toBe(later);
    // One no longer listed is forgotten.
    rcViewerEntries([], new Map(), (s) => s.id, seen, later, DAY_START);
    expect(seen.size).toBe(0);
  });

  it("stands in for a running session that was not read, names short ages and finds the next one waiting", () => {
    expect(runningStandIn("x", { pid: 2, name: "fix the build", cwd: "/w" }, "/p/x.jsonl", "/acc")).toMatchObject({ id: "x", title: "fix the build", cwd: "/w", account: "/acc", prompts: [] });
    expect([formatAge(5_000), formatAge(3 * 60_000), formatAge(2 * 3600_000), formatAge(50 * 3600_000)]).toEqual(["5s", "3m", "2h", "2d"]);
    const entries = rcViewerEntries(
      [summary("w1", 9), summary("b", 1), summary("w2", 5)],
      new Map([["w1", run("waiting")], ["b", run("busy")], ["w2", run("waiting")]]),
      (s) => s.id,
      new Map(),
      NOW,
      DAY_START,
    );
    expect(nextWaiting(entries, 0)).toBe(1);
    expect(nextWaiting(entries, 1)).toBe(0);
    expect(nextWaiting(entries.slice(2), 0)).toBeUndefined();
  });
});

describe("asking the Remote Control Viewer for a session", () => {
  it("finds a session of this machine by an id of its chain in its config folder, a remote one by its id", () => {
    const local = summary("new", 1, { continues: ["old"] });
    expect(matchesRequest(local, { id: "old", configDir: claudeDir() })).toBe(true);
    expect(matchesRequest(local, { id: "new", configDir: "/elsewhere" })).toBe(false);
    expect(matchesRequest({ ...local, account: "/elsewhere" }, { id: "new", configDir: "/elsewhere" })).toBe(true);
    const remote = summary("cse_1", 1, { remote: { loaded: false } });
    expect(matchesRequest(remote, { id: "cse_1", remote: true })).toBe(true);
    expect(matchesRequest(local, { id: "new", remote: true })).toBe(false);
  });

  it("names in the Sessions row whether it runs and how many wait", () => {
    expect(rcViewerRowLabel(false, 0)).toBe("⊞ open the Remote Control Viewer…");
    expect(rcViewerRowLabel(true, 2)).toBe("⊞ bring the Remote Control Viewer to the front · ⚠2 waiting");
  });
});

describe("Remote Control Viewer layout", () => {
  it("gives the sessions their column and the turns and chat what is left, after a border", () => {
    const { layout, aside } = rcViewerLayout(150, 30, "normal", "narrow");
    expect(aside).toBe(40);
    expect(layout.columns).toBe(150);
    expect(layout.listWidth + 3 + layout.previewWidth).toBe(150 - 42);
    expect(rcViewerLayout(150, 30, "hidden", "narrow").aside).toBe(0);
    expect(rcViewerLayout(150, 30, "full", "narrow").aside).toBe(150);
  });
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-rc-viewer-"));
});
afterEach(() => {
  setOwnSettings(undefined);
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("the Remote Control Viewer's settings", () => {
  it("are its own, taken from the project's viewer at the first start", () => {
    updateSettings({ showTools: "full", remoteApi: true });
    setOwnSettings("rcViewer");
    expect(readSettings()).toMatchObject({ showTools: "full", remoteApi: true, rcViewerSessionsWidth: "normal" });
    updateSettings({ showTools: "off", rcViewerTurnsWidth: "wide", remoteControl: true });
    const own = JSON.parse(readFileSync(rcViewerSettingsFile(), "utf8"));
    expect(own).toMatchObject({ showTools: "off", rcViewerTurnsWidth: "wide" });
    expect(own).not.toHaveProperty("remoteControl");
    expect(readMainSettings()).toMatchObject({ showTools: "full", remoteControl: true, rcViewerTurnsWidth: DEFAULT_SETTINGS.rcViewerTurnsWidth });
    // Only its two views.
    expect(isViewShown(readSettings(), "git")).toBe(false);
    expect(isViewShown(readSettings(), "chat")).toBe(true);
  });

  it("lists only its own settings, its widths among them, and its two resets", () => {
    setOwnSettings("rcViewer");
    const update = { state: { kind: "none" }, releases: [] } as unknown as Update;
    const entries = settingsEntries(update, undefined, true);
    const keys = entries.flatMap((e) => ("key" in e ? [e.key] : []));
    expect(keys.sort()).toEqual([...RC_VIEWER_KEYS].sort());
    expect(RC_VIEWER_ROWS.every((r) => keys.includes(r.key))).toBe(true);
    expect(entries.filter((e) => "id" in e)).toEqual(RC_VIEWER_RESET_ACTIONS);
  });
});

describe("Remote Control Viewer registration", () => {
  afterAll(() => rmSync(rcViewerFile(), { force: true }));

  it("records the running Remote Control Viewer, one per machine", () => {
    expect(runningRcViewer()).toBeUndefined();
    registerRcViewer({ configDir: claudeDir() });
    expect(runningRcViewer()).toMatchObject({ pid: process.pid });
  });
});

describe("the Remote Control Viewer's three columns", () => {
  const size = { columns: 140, rows: 24 };
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cco-rc-viewer-project-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    setOwnSettings("rcViewer");
  });

  /** A session whose prompt was `minutes` ago, with Claude's answer. */
  function session(id: string, title: string, minutes: number, answer: string) {
    const ts = new Date(Date.now() - minutes * 60_000).toISOString();
    const file = join(projectDir(cwd), `${id}.jsonl`);
    writeFileSync(
      file,
      [
        { type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: `prompt of ${title}` } },
        { type: "assistant", uuid: `${id}-a`, timestamp: ts, cwd, message: { id: `${id}-m`, role: "assistant", content: [{ type: "text", text: answer }], stop_reason: "end_turn" } },
        { type: "custom-title", customTitle: title, sessionId: id },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    return file;
  }

  /** Registers `id` as run by a Claude Code (this process, so it counts as alive) with `status`. */
  function running(id: string, status: string, pid = process.pid) {
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, status, cwd }));
  }

  it("groups the sessions by what they need, shows the selected one's turns and chat, and moves the keys between the columns", async () => {
    session("s-ended", "finished work", 30, "All done here.");
    session("s-wait", "needs an answer", 10, "Shall I go on?");
    const old = session("s-old", "yesterday's work", 60 * 30, "Old answer.");
    utimesSync(old, new Date(Date.now() - 30 * 3600_000), new Date(Date.now() - 30 * 3600_000));
    running("s-wait", "waiting");
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);
    await until(() => view.frame().includes("needs an answer") && view.frame().includes("finished work"));
    const frame = view.frame();
    const rows = frame.split("\n");
    const waitingRow = rows.findIndex((l) => l.includes("── Waiting"));
    const endedRow = rows.findIndex((l) => l.includes("── Ended"));
    expect(waitingRow).toBeGreaterThan(0);
    expect(endedRow).toBeGreaterThan(waitingRow);
    // Its ⚠ blinks: in the off phase a space stands in its place.
    expect(rows[waitingRow + 1]).toMatch(/[⚠ ] needs an answer/);
    expect(rows[endedRow + 1]).toContain("∅ finished work");
    expect(frame).not.toContain("yesterday's work");
    expect(frame).toContain("1 Remote Control");
    expect(frame).toContain("⚠ 1 waiting");
    // The waiting session is selected first: its turn and Claude's answer show beside it.
    await until(() => view.frame().includes("Shall I go on?"));
    expect(view.frame()).toContain("prompt of needs an answer");
    expect(view.frame()).toContain("←→ sessions");

    // ↓ selects the ended session; its chat follows.
    await view.press("\u001b[B");
    await until(() => view.frame().includes("All done here."));
    expect(view.frame()).toContain("All done here.");
    // → moves the keys to its turns, → again to the chat.
    await view.press("\u001b[C");
    await until(() => view.frame().includes("←→ turns"));
    expect(view.frame()).toContain("←→ turns");
    await view.press("\u001b[C");
    await until(() => view.frame().includes("←→ chat"));
    expect(view.frame()).toContain("↑↓ scroll");
    // n goes back to the session waiting for the user, in the sessions column.
    await view.press("n");
    await until(() => view.frame().includes("Shall I go on?"));
    expect(view.frame()).toContain("←→ sessions");
    view.unmount();
    rmSync(join(claudeDir(), "sessions"), { recursive: true, force: true });
  });

  it("selects the session it was opened for, once the list has it", async () => {
    session("s-a", "first work", 30, "Answer of a.");
    session("s-b", "second work", 10, "Answer of b.");
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} select={{ id: "s-a", configDir: claudeDir() }} />, size);
    await until(() => view.frame().includes("Answer of a."));
    expect(view.frame()).toContain("Answer of a.");
    view.unmount();
  });
});

describe("opening the Remote Control Viewer from Sessions", () => {
  const spawned: { cmd: string; args: string[] }[] = [];
  const real = { ...proc };
  const env = { ...process.env };
  const size = { columns: 120, rows: 24 };
  const layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
  beforeAll(() => {
    proc.spawn = ((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return { unref: () => {}, on: () => {} };
    }) as never;
  });
  afterAll(() => Object.assign(proc, real));
  afterEach(() => {
    for (const v of ["WT_SESSION", "TMUX"]) if (env[v] === undefined) delete process.env[v];
    rmSync(rcViewerFile(), { force: true });
  });

  it("reaches the Remote Control Viewer's row above the list with ↑ and opens it with Enter, and k opens it from anywhere", async () => {
    process.env.WT_SESSION = "x";
    delete process.env.TMUX;
    const cwd = mkdtempSync(join(tmpdir(), "cco-rc-viewer-sessions-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "only work" } }) + "\n");
    spawned.length = 0;
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, size);
    await until(() => view.frame().includes("only work"));
    expect(view.frame().split("\n")[1]).toContain("⊞ open the Remote Control Viewer…");
    await view.press("\u001b[A");
    await until(() => view.frame().includes("↵ Remote Control Viewer"));
    expect(view.frame()).toContain("The Remote Control Viewer: one window");
    await view.press("\r");
    await until(() => spawned.length > 0);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["rc-viewer", "--window", "cco-rc-viewer"]));
    // ↓ goes back to the list; k opens it too.
    await view.press("\u001b[B");
    await until(() => !view.frame().includes("↵ Remote Control Viewer"));
    await view.press("k");
    await until(() => spawned.length > 1);
    expect(spawned[1]!.args).toContain("rc-viewer");
    view.unmount();
  });

  it("asks a running Remote Control Viewer to select the session, and brings it to the front", () => {
    process.env.WT_SESSION = "x";
    registerRcViewer({ window: "cco-rc-viewer" });
    spawned.length = 0;
    expect(openRcViewer(runningRcViewer(), { id: "s1", configDir: claudeDir() })).toBe("brought the Remote Control Viewer to the front");
    expect(readRcViewerRequest()).toMatchObject({ id: "s1", configDir: claudeDir() });
    expect(spawned[0]!.args).toEqual(["-w", "cco-rc-viewer", "focus-tab", "-t", "0"]);
  });
});

describe("the Remote Control Viewer's Enter dialog", () => {
  const base: RcViewerSituation = { state: "idle", running: { pid: 1, activity: "idle" }, terminal: true, viewers: 0, command: "claude --resume s1" };
  const ids = (s: RcViewerSituation) => rcViewerOptions(s).options.map((o) => o.id);
  const first = (s: RcViewerSituation) => {
    const { options, initial } = rcViewerOptions(s);
    return options[initial]!.id;
  };

  it("offers a session of this machine its terminal, a prompt and, while Claude works, stopping it", () => {
    expect(ids(base)).toEqual(["switch", "prompt", "viewer", "copy"]);
    expect(first(base)).toBe("prompt");
    // Working: its terminal comes first, so a slip of Enter stops nothing.
    const busy = { ...base, state: "busy" as const, running: { pid: 1, activity: "busy" as const } };
    expect(ids(busy)).toEqual(["switch", "prompt", "interrupt", "viewer", "copy"]);
    expect(first(busy)).toBe("switch");
    // Waiting: its question or permission is answered in its terminal.
    const waiting = { ...base, state: "waiting" as const, promptBlocked: "Claude waits for you in its terminal" };
    expect(first(waiting)).toBe("switch");
    expect(rcViewerOptions(waiting).options.find((o) => o.id === "prompt")?.disabled).toBe("Claude waits for you in its terminal");
    // A background session has no tab to bring to the front.
    const bg = { ...base, running: { pid: 1, activity: "idle" as const, kind: "bg" as const, jobId: "j1" } };
    expect(rcViewerOptions(bg).options[0]!.disabled).toBe("a background session has no tab: claude attach j1");
    // An idle one that cannot be typed into (no tmux) falls back to its terminal.
    expect(first({ ...base, promptBlocked: "no tmux: cco cannot type into it" })).toBe("switch");
  });

  it("continues an ended session in a new window, or views it when its folder is gone", () => {
    const ended = { ...base, state: "ended" as const, running: undefined };
    expect(ids(ended)).toEqual(["window", "viewer", "copy"]);
    expect(first(ended)).toBe("window");
    expect(first({ ...ended, folderMissing: true })).toBe("viewer");
    expect(first({ ...ended, terminal: false })).toBe("viewer");
  });

  it("answers a waiting session of this machine connected to claude.ai there, its terminal next", () => {
    const pending = { requestId: "r1", toolName: "Bash", toolUseId: "t1", input: { command: "ls" }, suggestions: [], needsInteraction: true, sequence: 1 };
    const waiting = { ...base, state: "waiting" as const, bridge: { control: true, pending } };
    expect(ids(waiting)).toEqual(["answer", "switch", "prompt", "viewer", "copy"]);
    expect(first(waiting)).toBe("answer");
    // Steer remote off: answered in its terminal.
    expect(first({ ...waiting, bridge: { control: false, pending } })).toBe("switch");
    // Not waiting: as any session of this machine, prompts go through claude.ai.
    const idle = rcViewerOptions({ ...base, bridge: { control: true } });
    expect(idle.options.find((o) => o.id === "prompt")?.detail).toBe("in the line below the chat, through claude.ai");
  });

  it("answers what a remote session waits for, and sends nothing while steer remote is off", () => {
    const pending = { requestId: "r1", toolName: "Bash", toolUseId: "t1", input: { command: "ls" }, suggestions: [], needsInteraction: true, sequence: 1 };
    const remote: RcViewerSituation = { state: "waiting", remote: { control: true, pending }, terminal: true, viewers: 0, command: "https://claude.ai/code/x" };
    expect(ids(remote)).toEqual(["answer", "prompt", "interrupt", "viewer", "copy"]);
    expect(first(remote)).toBe("answer");
    expect(rcViewerOptions(remote).options[0]!.label).toBe("Allow or deny Bash");
    const off = { ...remote, remote: { control: false, pending } };
    expect(first(off)).toBe("viewer");
    expect(rcViewerOptions(off).options[0]!.disabled).toContain("steer remote is off");
    expect(first({ ...remote, state: "idle", remote: { control: true } })).toBe("prompt");
    expect(ids({ ...remote, state: "ended", remote: { control: true } })).toEqual(["viewer", "copy"]);
  });
});

describe("the Remote Control Viewer's prompt line", () => {
  const size = { columns: 140, rows: 30 };
  // tmux types: each send-keys is recorded with its pane; this process runs in %1, its parent in %2.
  const sent: { pane: string; keys: string[] }[] = [];
  const real = { ...proc };
  const saved = { ...process.env };
  let cwd: string;
  beforeAll(() => {
    proc.execFile = ((cmd: string, args: string[], _opts: object, done: (err: Error | null, stdout: string) => void) => {
      if (cmd === "tmux" && args[0] === "list-panes") done(null, `${process.pid} %1\n${process.ppid} %2\n`);
      else if (cmd === "tmux" && args[0] === "send-keys") {
        sent.push({ pane: args[2]!, keys: args.slice(3) });
        done(null, "");
      } else done(new Error("not faked"), "");
    }) as never;
  });
  afterAll(() => Object.assign(proc, real));
  beforeEach(() => {
    sent.length = 0;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-rc-viewer-prompt-"));
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%9";
    cwd = mkdtempSync(join(tmpdir(), "cco-rc-viewer-prompt-project-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    setOwnSettings("rcViewer");
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  /** A session whose prompt was `minutes` ago, run idle by the Claude Code `pid`. */
  function idleSession(id: string, title: string, minutes: number, pid: number) {
    const ts = new Date(Date.now() - minutes * 60_000).toISOString();
    const file = join(projectDir(cwd), `${id}.jsonl`);
    writeFileSync(
      file,
      [
        { type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: `prompt of ${title}` } },
        { type: "assistant", uuid: `${id}-a`, timestamp: ts, cwd, message: { id: `${id}-m`, role: "assistant", content: [{ type: "text", text: `answer of ${title}` }], stop_reason: "end_turn" } },
        { type: "custom-title", customTitle: title, sessionId: id },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, status: "idle", cwd }));
    // The list sorts by the last write: the newer one on top.
    utimesSync(file, new Date(ts), new Date(ts));
  }

  it("asks what to do on Enter, sends to the selected session and keeps each one's draft", async () => {
    idleSession("s-a", "first work", 5, process.pid);
    idleSession("s-b", "second work", 10, process.ppid);
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);
    await until(() => view.frame().includes("answer of first work") && view.frame().includes("second work"));
    expect(view.frame()).toContain("Space or a click: write a prompt");

    // Enter on the idle session: the dialog, writing a prompt selected; Enter gives the line the keys.
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toContain("Bring its terminal to the front");
    await view.press("\r");
    await until(() => view.frame().includes("Enter send"));
    await view.press("hello a");
    await view.press("\r");
    await expect.poll(() => sent.length, { timeout: 3000 }).toBe(2);
    expect(sent).toEqual([
      { pane: "%1", keys: ["-l", "hello a"] },
      { pane: "%1", keys: ["Enter"] },
    ]);

    // A draft for the first session stays with it: the second one's line starts empty and sends to its own pane.
    await until(() => !view.frame().includes("hello a"));
    await view.press("draft of a");
    await view.press("\u001b");
    await until(() => view.frame().includes("Space or a click") && view.frame().includes("draft of a"));
    await view.press("\u001b[D");
    await view.press("\u001b[D");
    await until(() => view.frame().includes("←→ sessions"));
    await view.press("\u001b[B");
    await until(() => view.frame().includes("answer of second work"));
    expect(view.frame()).not.toContain("draft of a");
    // Space from the sessions column gives the line the keys.
    await view.press(" ");
    await until(() => view.frame().includes("Enter send"));
    await view.press("hello b");
    await view.press("\r");
    await expect.poll(() => sent.length, { timeout: 3000 }).toBe(4);
    expect(sent.slice(2)).toEqual([
      { pane: "%2", keys: ["-l", "hello b"] },
      { pane: "%2", keys: ["Enter"] },
    ]);

    // Back on the first session, its draft is there again.
    await view.press("\u001b");
    await until(() => view.frame().includes("Space or a click"));
    await view.press("\u001b[D");
    await view.press("\u001b[D");
    await until(() => view.frame().includes("←→ sessions"));
    await view.press("\u001b[A");
    await until(() => view.frame().includes("draft of a"));
    // A click on the line gives it the keys too.
    await view.click(10, size.rows - 2);
    await until(() => view.frame().includes("Enter send"));
    expect(view.frame()).toContain("draft of a");
    view.unmount();
  });
});

describe("answering a remote session in the Remote Control Viewer", () => {
  const size = { columns: 140, rows: 34 };
  const capture = readFileSync(join(import.meta.dirname, "fixtures", "remote-capture.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
  // The recorded session while its question (#34) waits: its events up to then, and its list entry.
  const events = capture.filter((c) => c.kind === "event" && Number(c.data.sequence_num) <= 34).map((c) => c.data);
  const entry = capture.find((c) => c.kind === "session" && c.data.worker_status === "requires_action")!.data;
  const realFetch = remote.fetch;
  const saved = { ...process.env };
  let posted: Record<string, unknown>[];
  beforeEach(() => {
    const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-rc-viewer-remote-")));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
    setOwnSettings("rcViewer");
    updateSettings({ remoteApi: true, remoteControl: true });
    posted = [];
    remote.fetch = async (url, init) => {
      if (init.method === "POST") {
        posted.push(JSON.parse(String(init.body)).events[0].payload);
        return new Response("{}", { status: 200 });
      }
      const body = url.includes("/events") ? { data: [...events].reverse() } : { data: [entry] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
  });
  afterEach(() => {
    updateSettings({ remoteApi: false, remoteControl: false });
    remote.fetch = realFetch;
    process.env = { ...saved };
  });

  it("answers a session of this machine connected to claude.ai (⇄) through claude.ai, its chat read from its transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-rc-viewer-bridge-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(
      join(projectDir(cwd), "s-local.jsonl"),
      [
        { type: "user", uuid: "l-u", timestamp: ts, cwd, message: { role: "user", content: "ask me a colour" } },
        { type: "bridge-session", sessionId: "s-local", bridgeSessionId: String(entry.id) },
        { type: "custom-title", customTitle: "local twin", sessionId: "s-local" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s-local", status: "waiting", cwd }));
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);
    // Listed once, as the session of this machine; its question comes from claude.ai.
    await until(() => view.frame().includes("local twin") && view.frame().includes("Welche Farbe magst du?"));
    expect(view.frame()).not.toContain("rc-test");
    await until(() => view.frame().includes("ask me a colour"));
    expect(view.frame()).toContain("ask me a colour");
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toContain("›  Answer Claude's question");
    expect(view.frame()).toContain("Bring its terminal to the front");
    await view.press("\r");
    await until(() => view.frame().includes("Claude asks ·"));
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ type: "control_response", response: { response: { updatedInput: { answers: { "Welche Farbe magst du?": "Blau" } } } } });
    view.unmount();
  });

  it("lists it as waiting, and Enter answers its question in the prompt line's place", async () => {
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);
    await until(() => view.frame().includes("── Waiting") && view.frame().includes("Welche Farbe magst du?"));
    expect(view.frame()).toContain("⚠ 1 waiting");
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toContain("›  Answer Claude's question");
    await view.press("\r");
    await until(() => view.frame().includes("Claude asks ·"));
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      type: "control_response",
      response: { subtype: "success", response: { behavior: "allow", updatedInput: { answers: { "Welche Farbe magst du?": "Blau" } } } },
    });
    view.unmount();
  });
});

describe("sessions that just finished", () => {
  const entry = (key: string, state: RcViewerEntry["state"], since = 0): RcViewerEntry => ({ key, state, since, session: summary(key, 1) });
  const times = { long: 600_000, short: 3000 };
  const states = (pairs: [string, RcViewerEntry["state"]][]) => new Map(pairs);

  it("blink once the Remote Control Viewer saw them go from working or waiting to idle, not at its start", () => {
    const empty: FreshIdle = new Map();
    // At the start nothing was seen before: an idle session is not fresh.
    expect(updateFresh(empty, new Map(), [entry("a", "idle")], NOW, undefined, true, times)).toBe(empty);
    const fresh = updateFresh(empty, states([["a", "busy"], ["b", "waiting"], ["c", "idle"]]), [entry("a", "idle"), entry("b", "idle"), entry("c", "idle")], NOW, undefined, true, times);
    expect([...fresh.keys()]).toEqual(["a", "b"]);
    expect(fresh.get("a")).toEqual({ until: NOW + 600_000, short: false });
    // One selected in the focused Remote Control Viewer as it finishes blinks a moment only; unfocused, it counts as unseen.
    expect(updateFresh(empty, states([["a", "busy"]]), [entry("a", "idle")], NOW, "a", true, times).get("a")).toEqual({ until: NOW + 3000, short: true });
    expect(updateFresh(empty, states([["a", "busy"]]), [entry("a", "idle")], NOW, "a", false, times).get("a")?.short).toBe(false);
    // Working again, or gone from the list: no longer fresh.
    expect(updateFresh(fresh, states([["a", "idle"], ["b", "idle"]]), [entry("a", "busy")], NOW, undefined, true, times).size).toBe(0);
  });

  it("are where n goes after the waiting ones, the one finished first first", () => {
    const entries = [entry("w", "waiting", 5), entry("b", "busy"), entry("late", "idle", 30), entry("early", "idle", 10), entry("old", "idle", 1)];
    const fresh = (e: RcViewerEntry) => e.key === "late" || e.key === "early";
    expect(nextWaiting(entries, 1, fresh)).toBe(0);
    expect(nextWaiting(entries, 0, fresh)).toBe(3);
    expect(nextWaiting(entries, 3, fresh)).toBe(2);
    expect(nextWaiting(entries, 2, fresh)).toBe(0);
    expect(nextWaiting(entries.slice(1), 0)).toBeUndefined();
  });
});

describe("blinking marks", () => {
  /** Whether `mark` showed and was gone again in the frames written, in step with the blink. */
  const blinked = (frames: string[], line: (f: string) => string | undefined, mark: string) => {
    const seen = frames.map(line).filter((l): l is string => l !== undefined);
    return seen.some((l) => l.includes(mark)) && seen.some((l) => !l.includes(mark));
  };

  it("show a waiting session's ⚠ on and off in the Remote Control Viewer", async () => {
    setOwnSettings("rcViewer");
    const cwd = mkdtempSync(join(tmpdir(), "cco-rc-viewer-blink-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(
      join(projectDir(cwd), "s-w.jsonl"),
      [
        { type: "user", uuid: "w-u", timestamp: ts, cwd, message: { role: "user", content: "go" } },
        { type: "custom-title", customTitle: "asks you", sessionId: "s-w" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s-w", status: "waiting", cwd }));
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, { columns: 120, rows: 20 });
    await until(() => view.frame().includes("asks you"));
    await tick(4 * TIMING.blink);
    const row = (f: string) => f.split("\n").find((l) => l.includes("asks you"));
    expect(blinked(view.frames, row, "⚠ asks you")).toBe(true);
    view.unmount();
    rmSync(join(claudeDir(), "sessions"), { recursive: true, force: true });
  });
});
