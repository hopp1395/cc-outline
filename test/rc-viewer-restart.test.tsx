import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { reopenRcViewer } from "../src/open.js";
import { proc } from "../src/proc.js";
import { rcViewerFile, registerRcViewer } from "../src/rcViewer/registry.js";
import { setOwnSettings, updateSettings } from "../src/settings.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import { RC_VIEWER_REOPEN_BY_HAND, RcViewerApp, restartLines } from "../src/tui/RcViewerApp.js";
import { VERSION } from "../src/version.js";

const size = { columns: 140, rows: 30 };
const TERMINAL_VARS = ["WT_SESSION", "WT_PROFILE_ID", "TMUX", "TMUX_PANE", "WEZTERM_PANE"];
const spawned: { cmd: string; args: string[] }[] = [];
const real = { ...proc };
const saved = { ...process.env };

beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return { unref: () => {}, on: () => {} };
  }) as never;
  // tmux, for the prompt line: this process runs in pane %1.
  proc.execFile = ((cmd: string, args: string[], _opts: object, done: (err: Error | null, stdout: string) => void) => {
    if (cmd === "tmux" && args[0] === "list-panes") done(null, `${process.pid} %1\n`);
    else done(new Error("not faked"), "");
  }) as never;
});
afterAll(() => Object.assign(proc, real));
beforeEach(() => {
  spawned.length = 0;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-rc-restart-"));
  for (const v of TERMINAL_VARS) delete process.env[v];
  setOwnSettings("rcViewer");
});
afterEach(() => {
  setOwnSettings(undefined);
  process.env = { ...saved };
  rmSync(rcViewerFile(), { force: true });
});

const app = () => renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, size);

/** A session of this machine run idle by this process's Claude Code, so its prompt line takes text. */
function idleSession(id: string, title: string) {
  const cwd = mkdtempSync(join(tmpdir(), "cco-rc-restart-project-"));
  mkdirSync(projectDir(cwd), { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(projectDir(cwd), `${id}.jsonl`),
    [
      { type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: `prompt of ${title}` } },
      { type: "assistant", uuid: `${id}-a`, timestamp: ts, cwd, message: { id: `${id}-m`, role: "assistant", content: [{ type: "text", text: `answer of ${title}` }], stop_reason: "end_turn" } },
      { type: "custom-title", customTitle: title, sessionId: id },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status: "idle", cwd }));
}

describe("restarting the Remote Control Viewer", () => {
  it("asks first with r while confirm quit is on, and says when it cannot reopen itself", async () => {
    updateSettings({ confirmQuit: true });
    const view = app();
    await until(() => view.frame().includes("1 Remote Control"));
    await view.press("r");
    await expect.poll(view.frame).toContain("Restart the Remote Control Viewer?");
    expect(view.frame()).toContain("starting afresh");
    expect(view.frame()).not.toContain("not sent");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Restarting…");
    // Started by hand, without a terminal cco opens windows in: nothing is started.
    await expect.poll(view.frame, { timeout: 3000 }).toContain("✗ The Remote Control Viewer did not reopen");
    expect(view.frame()).toContain("start cco rc-viewer again");
    expect(spawned).toEqual([]);
    await view.press("\u001b");
    await expect.poll(view.frame).not.toContain("did not reopen");
    view.unmount();
  });

  it("restarts at once with confirm quit off: a new one in its window, after this one has exited", async () => {
    updateSettings({ confirmQuit: false });
    process.env.WT_SESSION = "x";
    registerRcViewer({ configDir: claudeDir(), window: "cco-rc-viewer" });
    const view = app();
    await until(() => view.frame().includes("1 Remote Control"));
    await view.press("r");
    await expect.poll(view.frame).toContain("Restarting…");
    expect(view.frame()).not.toContain("Restart the Remote Control Viewer?");
    await expect.poll(() => spawned.length, { timeout: 3000 }).toBe(1);
    expect(spawned[0]!.cmd).toBe("wt");
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(["-w", "cco-rc-viewer", "new-tab", "rc-viewer", "--config-dir", claudeDir(), "--window", "cco-rc-viewer", "--after-pid", String(process.pid)]));
    view.unmount();
  });

  it("always asks while a prompt is written but not sent, and says it is lost", async () => {
    updateSettings({ confirmQuit: false });
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%9";
    idleSession("s-a", "first work");
    const view = app();
    await until(() => view.frame().includes("answer of first work"));
    await view.press(" ");
    await until(() => view.frame().includes("Enter send"));
    await view.press("half a prompt");
    await view.press("\u001b");
    await until(() => view.frame().includes("Space or a click"));
    await view.press("r");
    await expect.poll(view.frame).toContain("Restart the Remote Control Viewer?");
    expect(view.frame()).toContain("not sent for 1 session is lost");
    // Esc keeps it running, with the draft.
    await view.press("\u001b");
    await expect.poll(view.frame).not.toContain("Restart the Remote Control Viewer?");
    expect(view.frame()).toContain("half a prompt");
    expect(spawned).toEqual([]);
    view.unmount();
  });

  it("keeps r for the setting in Settings, and restarts from its Reset entry", async () => {
    updateSettings({ confirmQuit: true });
    const view = app();
    await until(() => view.frame().includes("1 Remote Control"));
    await view.press("2");
    await until(() => view.frame().includes("Reset"));
    await view.press("r");
    expect(view.frame()).not.toContain("Restart the Remote Control Viewer?");
    // The Reset group's first entry: two above the last.
    await view.press("\u001b[F");
    await view.press("\u001b[A");
    await view.press("\u001b[A");
    await until(() => view.frame().includes("Reset: restart the Remote Control Viewer"));
    expect(view.frame()).not.toContain("Saved");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Restart the Remote Control Viewer?");
    view.unmount();
  });
});

describe("reopenRcViewer", () => {
  it("reopens only a Remote Control Viewer cco opened, in a terminal it opens windows in", () => {
    expect(reopenRcViewer("cco-rc-viewer")).toBe(false);
    process.env.TMUX = "/tmp/tmux";
    expect(reopenRcViewer(undefined)).toBe(false);
    expect(spawned).toEqual([]);
    expect(reopenRcViewer("cco-rc-viewer")).toBe(true);
    expect(spawned[0]!.cmd).toBe("tmux");
    expect(spawned[0]!.args.slice(0, 3)).toEqual(["new-window", "-n", "cco-rc-viewer"]);
    expect(spawned[0]!.args[3]).toContain(`'--after-pid' '${process.pid}'`);
  });

  it("names the version and the prompts that go", () => {
    expect(restartLines("", 0)).toEqual([`It opens again in its window with v${VERSION}, starting afresh: no session selected, every time in its state from 0.`]);
    expect(restartLines("", 2)[1]).toBe("The prompts written but not sent for 2 sessions are lost.");
    expect(RC_VIEWER_REOPEN_BY_HAND).toContain("close it with q");
  });
});
