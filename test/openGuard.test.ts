import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetOpens, openOnce } from "../src/openGuard.js";
import { openInDefaultApp, openRcViewer, openSessionViewer, resumeInNewWindow } from "../src/open.js";
import { proc } from "../src/proc.js";
import { alreadyRunningNotice } from "../src/rcViewer/alreadyRunning.js";
import { claimRcViewer, markRcViewerStarting, rcViewerFile, rcViewerStartFile, rcViewerStarting, readRcViewerRequest, runningRcViewer } from "../src/rcViewer/registry.js";
import { TIMING } from "../src/timing.js";
import { claudeDir } from "../src/transcript/locate.js";

const spawned: { cmd: string; args: string[] }[] = [];
const real = { ...proc };
const guard = TIMING.openGuard;
const saved = { ...process.env };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return { unref: () => {}, on: () => {} };
  }) as never;
  proc.execFile = ((cmd: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
    spawned.push({ cmd, args });
    done(null, "");
  }) as never;
});
afterAll(() => Object.assign(proc, real));
beforeEach(() => {
  spawned.length = 0;
  mkdirSync(dirname(rcViewerFile()), { recursive: true });
  // Long enough for the calls of one test.
  TIMING.openGuard = 60_000;
  for (const v of ["TMUX", "WEZTERM_PANE", "WT_PROFILE_ID"]) delete process.env[v];
  process.env.WT_SESSION = "x";
});
afterEach(() => {
  TIMING.openGuard = guard;
  forgetOpens();
  process.env = { ...saved };
  rmSync(rcViewerFile(), { force: true });
  rmSync(rcViewerStartFile(), { force: true });
});

describe("openOnce", () => {
  it("runs the same open once within the guard and hands back what it returned; another one runs at once", () => {
    let runs = 0;
    const open = () => `opened ${++runs}`;
    expect(openOnce("guard-a", open)).toBe("opened 1");
    expect(openOnce("guard-a", open)).toBe("opened 1");
    expect(openOnce("guard-b", open)).toBe("opened 2");
    expect(runs).toBe(2);
  });

  it("runs it again once the guard is over", () => {
    TIMING.openGuard = 0;
    let runs = 0;
    openOnce("guard-c", () => runs++);
    openOnce("guard-c", () => runs++);
    expect(runs).toBe(2);
  });

  it("keeps a run that has not finished, however long it takes, and records nothing for one that threw", async () => {
    TIMING.openGuard = 0;
    let finish!: (v: string) => void;
    let runs = 0;
    const slow = () => {
      runs++;
      return new Promise<string>((resolve) => (finish = resolve));
    };
    const first = openOnce("guard-d", slow);
    expect(openOnce("guard-d", slow)).toBe(first);
    finish("done");
    await expect(first).resolves.toBe("done");
    openOnce("guard-d", slow);
    expect(runs).toBe(2);
    expect(() =>
      openOnce("guard-e", () => {
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(openOnce("guard-e", () => "now")).toBe("now");
  });
});

describe("opening twice in a row (a double click, Enter twice)", () => {
  it("opens one session viewer, one window, one app", () => {
    const target = { sessionId: "guard-viewer", cwd: process.cwd() };
    expect(openSessionViewer(target, "t", "cco-viewer-1")).toBe("opened in a new window");
    expect(openSessionViewer(target, "t", "cco-viewer-2")).toBe("opened in a new window");
    expect(spawned).toHaveLength(1);
    resumeInNewWindow("guard-window", process.cwd(), "t");
    resumeInNewWindow("guard-window", process.cwd(), "t");
    expect(spawned).toHaveLength(2);
    openInDefaultApp("guard-file.png");
    openInDefaultApp("guard-file.png");
    expect(spawned).toHaveLength(3);
    // Another session's viewer opens at once.
    openSessionViewer({ sessionId: "guard-other", cwd: process.cwd() }, "t", "cco-viewer-3");
    expect(spawned).toHaveLength(4);
  });

  it("starts one Remote Control Viewer; another start while it starts passes on its session instead of opening a tab", () => {
    expect(openRcViewer(runningRcViewer())).toBe("opened the Remote Control Viewer in a new window");
    expect(openRcViewer(runningRcViewer())).toBe("opened the Remote Control Viewer in a new window");
    expect(spawned).toHaveLength(1);
    expect(rcViewerStarting()).toBeDefined();
    // Another session (/cco:rc-viewer of another Claude Code, a click on another session): no second tab either.
    expect(openRcViewer(runningRcViewer(), { id: "guard-s2", configDir: claudeDir() })).toBe("the Remote Control Viewer is starting");
    expect(spawned).toHaveLength(1);
    expect(readRcViewerRequest()).toMatchObject({ id: "guard-s2" });
  });

  it("starts a new one when the start it recorded is older than the time a start may take", () => {
    markRcViewerStarting();
    expect(rcViewerStarting()).toBeDefined();
    expect(rcViewerStarting(Date.now() + TIMING.rcViewerStart)).toBeUndefined();
    writeFileSync(rcViewerStartFile(), JSON.stringify({ at: Date.now() - TIMING.rcViewerStart - 1 }));
    expect(openRcViewer(undefined, { id: "guard-s3" })).toBe("opened the Remote Control Viewer in a new window");
    expect(spawned).toHaveLength(1);
  });

  it("forgets the start where it could not open one", () => {
    delete process.env.WT_SESSION;
    expect(openRcViewer(undefined, { id: "guard-s4" })).toBeUndefined();
    expect(existsSync(rcViewerStartFile())).toBe(false);
  });
});

describe("claimRcViewer", () => {
  it("registers this process and forgets the recorded start", () => {
    markRcViewerStarting();
    expect(claimRcViewer({ window: "cco-rc-viewer" })).toBeUndefined();
    expect(JSON.parse(readFileSync(rcViewerFile(), "utf8"))).toMatchObject({ pid: process.pid, window: "cco-rc-viewer" });
    expect(existsSync(rcViewerStartFile())).toBe(false);
  });

  it("leaves the registration of one that runs alone and returns it", () => {
    // The parent process runs; its registration was touched just now.
    const other = { pid: process.ppid, window: "cco-rc-viewer", started: Date.now() - 60_000 };
    writeFileSync(rcViewerFile(), JSON.stringify(other));
    expect(claimRcViewer({ window: "cco-rc-viewer" })).toMatchObject({ pid: process.ppid });
    expect(JSON.parse(readFileSync(rcViewerFile(), "utf8"))).toEqual(other);
  });

  it("takes over the registration of one that is gone or no longer beats", () => {
    writeFileSync(rcViewerFile(), JSON.stringify({ pid: process.ppid, started: Date.now() - 3_600_000 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(rcViewerFile(), old, old);
    expect(claimRcViewer({})).toBeUndefined();
    expect(JSON.parse(readFileSync(rcViewerFile(), "utf8")).pid).toBe(process.pid);
  });
});

describe("alreadyRunningNotice", () => {
  const now = new Date(2026, 10, 4, 12, 0);
  const other = { pid: 4242, window: "cco-rc-viewer", started: new Date(2026, 10, 4, 10, 42).getTime() };

  it("says where the one that runs is and how to close the tab", () => {
    expect(alreadyRunningNotice(other, "cco-rc-viewer", "wt", now)).toEqual([
      "The Remote Control Viewer runs already (pid 4242, since 10:42), in another tab of this window.",
      "One runs per machine: it shows the sessions of every project and account.",
      "",
      "Press any key to close this tab.",
    ]);
    expect(alreadyRunningNotice(other, "cco-rc-viewer", "tmux", now)[0]).toContain("in another window.");
  });

  it("started by hand: in another terminal, and a key quits; one started another day names the day", () => {
    const lines = alreadyRunningNotice({ ...other, started: new Date(2026, 10, 3, 9, 5).getTime() }, undefined, "wt", now);
    expect(lines[0]).toBe("The Remote Control Viewer runs already (pid 4242, since 2026-11-03 09:05), in another terminal.");
    expect(lines.at(-1)).toBe("Press any key to quit.");
  });
});
