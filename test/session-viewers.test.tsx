import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { focusSessionViewer, openSessionViewer, viewerCommand } from "../src/open.js";
import { proc } from "../src/proc.js";
import { removeStaleSessionViewers, runningSessionViewers, sessionViewersDir, viewersOf, type SessionViewerInfo } from "../src/sessionViewers.js";
import { setSessionViewer } from "../src/settings.js";
import { claudeDir, projectDir, writeJson } from "../src/transcript/locate.js";
import { App } from "../src/tui/App.js";
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
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-viewers-"));
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(sessionViewersDir(), { recursive: true, force: true });
});

/** A registration as `registerSessionViewer` writes it, for process `pid`. */
function registered(pid: number, info: Partial<SessionViewerInfo>) {
  mkdirSync(sessionViewersDir(), { recursive: true });
  writeJson(join(sessionViewersDir(), `${pid}.json`), { pid, started: Date.now(), ...info });
}
/** A pid no process has. */
const DEAD = 2 ** 30;

describe("the session viewers' registrations", () => {
  it("lists the running ones, ignoring dead ones until they are cleaned up", () => {
    registered(process.pid, { sessionId: "s1", configDir: claudeDir(), window: "cco-view-1" });
    registered(DEAD, { sessionId: "s1" });
    writeFileSync(join(sessionViewersDir(), "junk.json"), "not json");
    expect(runningSessionViewers().map((o) => o.pid)).toEqual([process.pid]);
    expect(removeStaleSessionViewers()).toBe(2);
    expect(runningSessionViewers()).toHaveLength(1);
  });

  it("matches a session along its chain and in its config folder, and a remote one by its id", () => {
    const all: SessionViewerInfo[] = [
      { pid: 1, sessionId: "old", configDir: "/c/a", started: 1 },
      { pid: 2, sessionId: "new", configDir: "/c/b", started: 2 },
      { pid: 3, remoteId: "cse_1", started: 3 },
    ];
    expect(viewersOf(all, { ids: ["new", "old"], configDir: "/c/a" }).map((o) => o.pid)).toEqual([1]);
    expect(viewersOf(all, { ids: ["new"], configDir: "/c/b" }).map((o) => o.pid)).toEqual([2]);
    expect(viewersOf(all, { remoteId: "cse_1" }).map((o) => o.pid)).toEqual([3]);
  });
});

describe("opening a session viewer", () => {
  it("opens a window of its own each time in Windows Terminal, and brings one to the front", () => {
    process.env.WT_SESSION = "x";
    expect(openSessionViewer({ sessionId: "s1", cwd: "W:\\repo" }, "👁 orders", "cco-view-ab")).toBe("opened in a new window");
    expect(spawned[0]).toEqual({
      cmd: "wt",
      args: ["-w", "cco-view-ab", "new-tab", "--title", "👁 orders", process.execPath, expect.stringMatching(/cli\.js$/), "watch", "--session", "s1", "--cwd", "W:\\repo", "--config-dir", claudeDir(), "--window", "cco-view-ab"],
    });
    openSessionViewer({ remoteId: "cse_1" }, "👁 ◈ x", "cco-view-cd");
    expect(spawned[1]!.args).toEqual(expect.arrayContaining(["watch", "--remote", "cse_1", "--window", "cco-view-cd"]));
    expect(focusSessionViewer("cco-view-ab")).toBe(true);
    expect(spawned[2]).toEqual({ cmd: "wt", args: ["-w", "cco-view-ab", "focus-tab", "-t", "0"] });
  });

  it("opens a tmux window, and without a terminal leaves it to the command", () => {
    process.env.TMUX = "/tmp/tmux";
    openSessionViewer({ sessionId: "s1", cwd: "/repo" }, "x", "cco-view-ab");
    expect(spawned[0]!.args.slice(0, 3)).toEqual(["new-window", "-n", "cco-view-ab"]);
    expect(spawned[0]!.args[3]).toContain("'watch' '--session' 's1'");
    delete process.env.TMUX;
    expect(openSessionViewer({ sessionId: "s1", cwd: "/repo" }, "x", "w")).toBeUndefined();
    expect(focusSessionViewer("w")).toBe(false);
    expect(viewerCommand({ sessionId: "s1", cwd: "C:\\My Repo" }, "win32")).toBe('cco watch --session s1 --cwd "C:\\My Repo"');
    expect(viewerCommand({ sessionId: "s1", cwd: "/repo", configDir: "/home/x/.claude-work" }, "linux")).toBe("cco watch --session s1 --cwd /repo --config-dir /home/x/.claude-work");
  });
});

describe("a viewer of one session", () => {
  const layout: Layout = { columns: 110, rows: 24, listWidth: 40, previewWidth: 67, bodyHeight: 20 };
  const cwd = join(tmpdir(), "cco-observed-project");
  beforeEach(() => setSessionViewer(true));
  afterEach(() => setSessionViewer(false));

  const write = (lines: object[]) => {
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const prompt = { type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "watch me work" } };
  const titled = { type: "custom-title", customTitle: "Orders", sessionId: "s1" };

  it("shows the session's chat and its settings only, with its title, and has no keys to move or restart", async () => {
    write([prompt, titled]);
    const app = renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("watch me work"));
    const top = app.frame().split("\n")[0]!;
    expect(top).not.toContain("observing");
    expect(top).toContain("Orders");
    expect(top).toContain(" 1 Chat ");
    expect(top).toContain(" 6 Settings ");
    expect(top).not.toContain("Sessions");
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
    const app = renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("Claude is working"));
    app.unmount();
  });
});
