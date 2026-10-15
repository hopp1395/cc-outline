import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observersDir, observersOf, removeStaleObservers, runningObservers, type ObserverInfo } from "../src/observers.js";
import { focusObserver, observerCommand, openObserver } from "../src/open.js";
import { proc } from "../src/proc.js";
import { setViewLimit } from "../src/settings.js";
import { claudeDir, projectDir, writeJson } from "../src/transcript/locate.js";
import { App, REMOTE_VIEWS } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { renderInk, until } from "./helpers/ink.js";

const spawned: { cmd: string; args: string[] }[] = [];
const real = { ...proc };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return { unref: () => {} };
  }) as never;
});
afterAll(() => {
  Object.assign(proc, real);
});

const saved = { ...process.env };
beforeEach(() => {
  spawned.length = 0;
  for (const v of ["TMUX", "TMUX_PANE", "WT_SESSION", "WT_PROFILE_ID"]) delete process.env[v];
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-observers-"));
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(observersDir(), { recursive: true, force: true });
});

/** A registration as `registerObserver` writes it, for process `pid`. */
function registered(pid: number, info: Partial<ObserverInfo>) {
  mkdirSync(observersDir(), { recursive: true });
  writeJson(join(observersDir(), `${pid}.json`), { pid, started: Date.now(), ...info });
}
/** A pid no process has. */
const DEAD = 2 ** 30;

describe("the observers' registrations", () => {
  it("lists the running ones, ignoring dead ones until they are cleaned up", () => {
    registered(process.pid, { sessionId: "s1", configDir: claudeDir(), window: "cco-observe-1" });
    registered(DEAD, { sessionId: "s1" });
    writeFileSync(join(observersDir(), "junk.json"), "not json");
    expect(runningObservers().map((o) => o.pid)).toEqual([process.pid]);
    expect(removeStaleObservers()).toBe(2);
    expect(runningObservers()).toHaveLength(1);
  });

  it("matches a session along its chain and in its config folder, and a remote one by its id", () => {
    const all: ObserverInfo[] = [
      { pid: 1, sessionId: "old", configDir: "/c/a", started: 1 },
      { pid: 2, sessionId: "new", configDir: "/c/b", started: 2 },
      { pid: 3, remoteId: "cse_1", started: 3 },
    ];
    expect(observersOf(all, { ids: ["new", "old"], configDir: "/c/a" }).map((o) => o.pid)).toEqual([1]);
    expect(observersOf(all, { ids: ["new"], configDir: "/c/b" }).map((o) => o.pid)).toEqual([2]);
    expect(observersOf(all, { remoteId: "cse_1" }).map((o) => o.pid)).toEqual([3]);
  });
});

describe("opening an observer", () => {
  it("opens a window of its own each time in Windows Terminal, and brings one to the front", () => {
    process.env.WT_SESSION = "x";
    expect(openObserver({ sessionId: "s1", cwd: "W:\\repo" }, "👁 orders", "cco-observe-ab")).toBe("observing it in a new window");
    expect(spawned[0]).toEqual({
      cmd: "wt",
      args: ["-w", "cco-observe-ab", "new-tab", "--title", "👁 orders", process.execPath, expect.stringMatching(/cli\.js$/), "watch", "--session", "s1", "--cwd", "W:\\repo", "--config-dir", claudeDir(), "--window", "cco-observe-ab"],
    });
    openObserver({ remoteId: "cse_1" }, "👁 ◈ x", "cco-observe-cd");
    expect(spawned[1]!.args).toEqual(expect.arrayContaining(["watch", "--remote", "cse_1", "--observe", "--window", "cco-observe-cd"]));
    expect(focusObserver("cco-observe-ab")).toBe(true);
    expect(spawned[2]).toEqual({ cmd: "wt", args: ["-w", "cco-observe-ab", "focus-tab", "-t", "0"] });
  });

  it("opens a tmux window, and without a terminal leaves it to the command", () => {
    process.env.TMUX = "/tmp/tmux";
    openObserver({ sessionId: "s1", cwd: "/repo" }, "x", "cco-observe-ab");
    expect(spawned[0]!.args.slice(0, 3)).toEqual(["new-window", "-n", "cco-observe-ab"]);
    expect(spawned[0]!.args[3]).toContain("'watch' '--session' 's1'");
    delete process.env.TMUX;
    expect(openObserver({ sessionId: "s1", cwd: "/repo" }, "x", "w")).toBeUndefined();
    expect(focusObserver("w")).toBe(false);
    expect(observerCommand({ sessionId: "s1", cwd: "C:\\My Repo" }, "win32")).toBe('cco watch --session s1 --cwd "C:\\My Repo"');
    expect(observerCommand({ sessionId: "s1", cwd: "/repo", configDir: "/home/x/.claude-work" }, "linux")).toBe("cco watch --session s1 --cwd /repo --config-dir /home/x/.claude-work");
  });
});

describe("an observer", () => {
  const layout: Layout = { columns: 110, rows: 24, listWidth: 40, previewWidth: 67, bodyHeight: 20 };
  const cwd = join(tmpdir(), "cco-observed-project");
  beforeEach(() => setViewLimit(REMOTE_VIEWS));
  afterEach(() => setViewLimit(undefined));

  const write = (lines: object[]) => {
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const prompt = { type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "watch me work" } };
  const titled = { type: "custom-title", customTitle: "Orders", sessionId: "s1" };

  it("shows the session's chat only, says that it observes, and has no keys to move or restart", async () => {
    write([prompt, titled]);
    const app = renderInk(<App cwd={cwd} sessionId="s1" observe initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("watch me work"));
    const top = app.frame().split("\n")[0]!;
    expect(top).toContain(" observing ");
    expect(top).toContain("Orders");
    expect(top).not.toContain("Chat");
    // A session that runs nowhere: no "Claude is working" for its unfinished turn.
    expect(app.frame()).not.toContain("Claude is working");
    await app.press("i");
    await until(() => app.frame().includes("reload this view"));
    expect(app.frame()).not.toContain("restart the viewer");
    expect(app.frame()).not.toContain("move: right");
    app.unmount();
  });

  it("shows Claude working while the session runs in a Claude Code", async () => {
    write([prompt]);
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", status: "busy" }));
    const app = renderInk(<App cwd={cwd} sessionId="s1" observe initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("Claude is working"));
    app.unmount();
  });
});
