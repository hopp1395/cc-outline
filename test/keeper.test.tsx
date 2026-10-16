import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { formatAge, keeperEntries, keeperState, nextWaiting, runningStandIn, type SeenStates } from "../src/keeper/state.js";
import { registerKeeper, runningKeeper, keeperFile } from "../src/keeper/registry.js";
import { openKeeper } from "../src/open.js";
import { DEFAULT_SETTINGS, isViewShown, KEEPER_KEYS, keeperSettingsFile, readMainSettings, readSettings, setOwnSettings, updateSettings } from "../src/settings.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import type { RunningSession } from "../src/transcript/trash.js";
import { KeeperApp } from "../src/tui/KeeperApp.js";
import { matchesRequest } from "../src/tui/KeeperView.js";
import { keeperRowLabel, SessionsView } from "../src/tui/SessionsView.js";
import { proc } from "../src/proc.js";
import { readKeeperRequest } from "../src/keeper/registry.js";
import { keeperLayout } from "../src/tui/layout.js";
import { KEEPER_RESET_ACTIONS, KEEPER_ROWS, settingsEntries } from "../src/tui/SettingsView.js";
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

describe("keeper state", () => {
  it("tells waiting, working, idle and ended apart, for this machine's sessions and remote ones", () => {
    expect(keeperState(summary("a", 1), run("waiting"))).toBe("waiting");
    expect(keeperState(summary("a", 1), run("busy"))).toBe("busy");
    expect(keeperState(summary("a", 1), run("idle"))).toBe("idle");
    // Before Claude Code wrote a status, a running session counts as idle.
    expect(keeperState(summary("a", 1), run())).toBe("idle");
    expect(keeperState(summary("a", 1))).toBe("ended");
    const remote = (workerStatus: string, connectionStatus = "connected") => summary("r", 1, { remote: { loaded: false, workerStatus, connectionStatus } });
    expect(keeperState(remote("requires_action"))).toBe("waiting");
    expect(keeperState(remote("running"))).toBe("busy");
    expect(keeperState(remote("idle"))).toBe("idle");
    expect(keeperState(remote("idle", "disconnected"))).toBe("ended");
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
    const entries = keeperEntries(sessions, running, (s) => s.id, seen, NOW, DAY_START);
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
    keeperEntries(sessions, new Map([["a", run("busy")]]), (s) => s.id, seen, NOW, DAY_START);
    const later = NOW + 60_000;
    expect(keeperEntries(sessions, new Map([["a", run("busy")]]), (s) => s.id, seen, later, DAY_START)[0]!.since).toBe(NOW - 10 * 60_000);
    expect(keeperEntries(sessions, new Map([["a", run("waiting")]]), (s) => s.id, seen, later, DAY_START)[0]!.since).toBe(later);
    // One no longer listed is forgotten.
    keeperEntries([], new Map(), (s) => s.id, seen, later, DAY_START);
    expect(seen.size).toBe(0);
  });

  it("stands in for a running session that was not read, names short ages and finds the next one waiting", () => {
    expect(runningStandIn("x", { pid: 2, name: "fix the build", cwd: "/w" }, "/p/x.jsonl", "/acc")).toMatchObject({ id: "x", title: "fix the build", cwd: "/w", account: "/acc", prompts: [] });
    expect([formatAge(5_000), formatAge(3 * 60_000), formatAge(2 * 3600_000), formatAge(50 * 3600_000)]).toEqual(["5s", "3m", "2h", "2d"]);
    const entries = keeperEntries(
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

describe("asking the keeper for a session", () => {
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
    expect(keeperRowLabel(false, 0)).toBe("⊞ open the keeper…");
    expect(keeperRowLabel(true, 2)).toBe("⊞ bring the keeper to the front · ⚠2 waiting");
  });
});

describe("keeper layout", () => {
  it("gives the sessions their column and the turns and chat what is left, after a border", () => {
    const { layout, aside } = keeperLayout(150, 30, "normal", "narrow");
    expect(aside).toBe(40);
    expect(layout.columns).toBe(150);
    expect(layout.listWidth + 3 + layout.previewWidth).toBe(150 - 42);
    expect(keeperLayout(150, 30, "hidden", "narrow").aside).toBe(0);
    expect(keeperLayout(150, 30, "full", "narrow").aside).toBe(150);
  });
});

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-keeper-"));
});
afterEach(() => {
  setOwnSettings(undefined);
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("the keeper's settings", () => {
  it("are its own, taken from the project's viewer at the first start", () => {
    updateSettings({ showTools: "full", remoteApi: true });
    setOwnSettings("keeper");
    expect(readSettings()).toMatchObject({ showTools: "full", remoteApi: true, keeperSessionsWidth: "normal" });
    updateSettings({ showTools: "off", keeperTurnsWidth: "wide", remoteControl: true });
    const own = JSON.parse(readFileSync(keeperSettingsFile(), "utf8"));
    expect(own).toMatchObject({ showTools: "off", keeperTurnsWidth: "wide" });
    expect(own).not.toHaveProperty("remoteControl");
    expect(readMainSettings()).toMatchObject({ showTools: "full", remoteControl: true, keeperTurnsWidth: DEFAULT_SETTINGS.keeperTurnsWidth });
    // Only its two views.
    expect(isViewShown(readSettings(), "git")).toBe(false);
    expect(isViewShown(readSettings(), "chat")).toBe(true);
  });

  it("lists only its own settings, its widths among them, and its two resets", () => {
    setOwnSettings("keeper");
    const update = { state: { kind: "none" }, releases: [] } as unknown as Update;
    const entries = settingsEntries(update, undefined, true);
    const keys = entries.flatMap((e) => ("key" in e ? [e.key] : []));
    expect(keys.sort()).toEqual([...KEEPER_KEYS].sort());
    expect(KEEPER_ROWS.every((r) => keys.includes(r.key))).toBe(true);
    expect(entries.filter((e) => "id" in e)).toEqual(KEEPER_RESET_ACTIONS);
  });
});

describe("keeper registration", () => {
  afterAll(() => rmSync(keeperFile(), { force: true }));

  it("records the running keeper, one per machine", () => {
    expect(runningKeeper()).toBeUndefined();
    registerKeeper({ configDir: claudeDir() });
    expect(runningKeeper()).toMatchObject({ pid: process.pid });
  });
});

describe("the keeper's three columns", () => {
  const size = { columns: 140, rows: 24 };
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cco-keeper-project-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    setOwnSettings("keeper");
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
    const view = renderInk(<KeeperApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);
    await until(() => view.frame().includes("needs an answer") && view.frame().includes("finished work"));
    const frame = view.frame();
    const rows = frame.split("\n");
    const waitingRow = rows.findIndex((l) => l.includes("── Waiting"));
    const endedRow = rows.findIndex((l) => l.includes("── Ended"));
    expect(waitingRow).toBeGreaterThan(0);
    expect(endedRow).toBeGreaterThan(waitingRow);
    expect(rows[waitingRow + 1]).toContain("⚠ needs an answer");
    expect(rows[endedRow + 1]).toContain("∅ finished work");
    expect(frame).not.toContain("yesterday's work");
    expect(frame).toContain("1 Keeper");
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
    const view = renderInk(<KeeperApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} select={{ id: "s-a", configDir: claudeDir() }} />, size);
    await until(() => view.frame().includes("Answer of a."));
    expect(view.frame()).toContain("Answer of a.");
    view.unmount();
  });
});

describe("opening the keeper from Sessions", () => {
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
    rmSync(keeperFile(), { force: true });
  });

  it("reaches the keeper's row above the list with ↑ and opens it with Enter, and k opens it from anywhere", async () => {
    process.env.WT_SESSION = "x";
    delete process.env.TMUX;
    const cwd = mkdtempSync(join(tmpdir(), "cco-keeper-sessions-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "only work" } }) + "\n");
    spawned.length = 0;
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, size);
    await until(() => view.frame().includes("only work"));
    expect(view.frame().split("\n")[1]).toContain("⊞ open the keeper…");
    await view.press("\u001b[A");
    await until(() => view.frame().includes("↵ keeper"));
    expect(view.frame()).toContain("The keeper: one window");
    await view.press("\r");
    await until(() => spawned.length > 0);
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["keeper", "--window", "cco-keeper"]));
    // ↓ goes back to the list; k opens it too.
    await view.press("\u001b[B");
    await until(() => !view.frame().includes("↵ keeper"));
    await view.press("k");
    await until(() => spawned.length > 1);
    expect(spawned[1]!.args).toContain("keeper");
    view.unmount();
  });

  it("asks a running keeper to select the session, and brings it to the front", () => {
    process.env.WT_SESSION = "x";
    registerKeeper({ window: "cco-keeper" });
    spawned.length = 0;
    expect(openKeeper(runningKeeper(), { id: "s1", configDir: claudeDir() })).toBe("brought the keeper to the front");
    expect(readKeeperRequest()).toMatchObject({ id: "s1", configDir: claudeDir() });
    expect(spawned[0]!.args).toEqual(["-w", "cco-keeper", "focus-tab", "-t", "0"]);
  });
});
