import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateSettings } from "../src/settings.js";
import { renderInk, tick, until } from "./helpers/ink.js";
import { proc } from "../src/proc.js";
import { commandSteps, prepareConsoleInput, promptSteps, stepsLine } from "../src/switchSession.js";
import { claudeDir, pairingFile, projectDir, readJson } from "../src/transcript/locate.js";
import { TranscriptParser, type Turn } from "../src/transcript/parse.js";
import { renameSession } from "../src/transcript/rename.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { enterLabel, isEmptySession, sessionOptions } from "../src/tui/resumeChoice.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import type { PairTarget } from "../src/viewer.js";
import { AccountContext } from "../src/tui/useAccount.js";
import { inClaudeDir, projectSlug } from "../src/transcript/locate.js";
import { readTransfers } from "../src/transfers.js";
import { sessionViewersDir } from "../src/sessionViewers.js";

const spawned: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; typed?: string; killed?: boolean }[] = [];
/** What a started PowerShell prints once it got its line; "ok" types, anything else fails. */
let typerAnswer = "";
const real = { ...proc };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const call: (typeof spawned)[number] = { cmd, args, env: opts?.env };
    spawned.push(call);
    const child = Object.assign(new EventEmitter(), {
      unref: () => {},
      stdout: new EventEmitter(),
      kill: () => {
        call.killed = true;
        child.emit("exit");
      },
      stdin: {
        end: (line?: string) => {
          call.typed = line;
          setTimeout(() => {
            if (line) child.stdout.emit("data", typerAnswer);
            child.emit("exit");
          }, 0);
        },
      },
    });
    return child;
  }) as never;
  proc.execFile = ((cmd: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
    spawned.push({ cmd, args });
    done(null, "");
  }) as never;
});
afterAll(() => {
  Object.assign(proc, real);
});

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const cwd = join(tmpdir(), "cco-resume-project");

const saved = { ...process.env };
beforeEach(() => {
  spawned.length = 0;
  typerAnswer = "";
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-resume-"));
  for (const v of ["TMUX", "TMUX_PANE", "WT_SESSION", "WT_PROFILE_ID"]) delete process.env[v];
  // OSC 52 through the test's stdout, never the machine's clipboard.
  process.env.WT_SESSION = "x";
  mkdirSync(projectDir(cwd), { recursive: true });
  // The session's folder: it is continued there.
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  process.env = { ...saved };
});

const turn = (prompt: string): Turn => ({ id: prompt, prompt, blocks: [], done: true });

describe("isEmptySession", () => {
  it("counts no turns and a /clear at the start as empty, anything else not", () => {
    expect(isEmptySession([])).toBe(true);
    expect(isEmptySession([turn("/clear")])).toBe(true);
    expect(isEmptySession([turn("/rename x")])).toBe(false);
    expect(isEmptySession([turn("/clear"), turn("/rename x")])).toBe(false);
    expect(isEmptySession([turn("/clearance")])).toBe(false);
  });
});

type Situation = import("../src/tui/resumeChoice.js").SessionSituation;
const base: Situation = { state: "inactive", terminal: true, folder: "~/proj", command: "claude --resume s1" };
const idle = { empty: true, activity: "idle" as const, method: "keys" as const };
/** The option ids, the selected one marked with ✱ and disabled ones with ✗. */
const shown = (s: Partial<Situation>) => {
  const { options, initial } = sessionOptions({ ...base, ...s });
  return options.map((o, i) => `${i === initial ? "✱" : ""}${o.disabled ? "✗" : ""}${o.id}`).join(" ");
};

describe("sessionOptions", () => {
  it("offers its own session to stay or detach", () => {
    expect(shown({ paired: idle, state: "current" })).toBe("✱stay detach viewer folder ✗rename export import copy");
  });

  it("switches to a running session by default, and attaches the viewer there if that Claude Code has none", () => {
    expect(shown({ paired: idle, state: "active" })).toBe("✱switch attach viewer folder ✗rename export import copy");
    expect(shown({ paired: idle, state: "active", attachBlocked: "it has a viewer of its own" })).toBe("✱switch ✗attach viewer folder ✗rename export import copy");
    // A viewer of no Claude Code attaches by default.
    expect(shown({ state: "active" })).toBe("✱attach switch viewer folder ✗rename export import copy");
    expect(shown({ state: "active", attachBlocked: "it has a viewer of its own" })).toBe("✗attach ✱switch viewer folder ✗rename export import copy");
  });

  it("continues a session that runs nowhere here when the viewer's Claude Code has no prompt yet, else in a new window", () => {
    expect(shown({ paired: idle })).toBe("✱here window viewer folder rename export import copy");
    expect(shown({ paired: { ...idle, empty: false } })).toBe("here ✱window viewer folder rename export import copy");
    // Versions without a status count as free.
    expect(shown({ paired: { empty: true, method: "clipboard" } })).toBe("✱here window viewer folder rename export import copy");
    // Only a viewer without a Claude Code moves along: a session started elsewhere gets a viewer of its own.
    expect(shown({})).toBe("✱window-attach window viewer folder rename export import copy");
  });

  it("greys out continuing here while Claude works or waits, and for another project folder", () => {
    for (const activity of ["busy", "waiting"] as const) expect(shown({ paired: { ...idle, activity } })).toBe("✗here ✱window viewer folder rename export import copy");
    const { options } = sessionOptions({ ...base, paired: idle, otherFolder: "other" });
    expect(options[0]!.disabled).toBe("ran in other, not in this folder");
  });

  it("falls back to a viewer of it when nothing else can be done", () => {
    expect(shown({ paired: { ...idle, activity: "busy" }, terminal: false })).toBe("✗here ✗window ✱viewer folder rename export import copy");
    expect(shown({ folderMissing: true })).toBe("✗window-attach ✗window ✱viewer ✗folder rename export import copy");
    expect(shown({ state: "active", terminal: false, attachBlocked: "it has a viewer of its own" })).toBe("✗attach ✗switch ✱viewer folder ✗rename export import copy");
  });

  it("moves a session whose folder is gone here first, and exports the marked sessions where there are some", () => {
    expect(shown({ folderMissing: true, movable: "old" })).toBe("✱move ✗window-attach ✗window viewer ✗folder rename export import copy");
    expect(enterLabel({ ...base, folderMissing: true, movable: "old" })).toBe("↵ move to this project");
    const label = (marked: number) => sessionOptions({ ...base, marked }).options.find((o) => o.id === "export")!.label;
    expect(label(0)).toBe("Export it");
    expect(label(3)).toBe("Export 3 marked sessions");
  });

  it("offers another account only when one is signed in, for every state, but not for a session whose folder is gone", () => {
    expect(shown({ paired: idle, accounts: ["b@x"] })).toBe("✱here window account viewer folder rename export import copy");
    expect(shown({ paired: idle, state: "current", accounts: ["b@x"] })).toBe("✱stay detach account viewer folder ✗rename export import copy");
    expect(shown({ folderMissing: true, accounts: ["b@x"] })).toBe("✗window-attach ✗window ✗account ✱viewer ✗folder rename export import copy");
    const option = (accounts: string[]) => sessionOptions({ ...base, accounts }).options.find((o) => o.id === "account")!;
    expect(option(["b@x"])).toMatchObject({ label: "Continue it in b@x…", detail: "a copy, in a new Claude Code window" });
    expect(option(["b@x", "c@x"])).toMatchObject({ label: "Continue it in another account…", detail: "a copy in one of 2 other accounts, in a new Claude Code window" });
  });

  it("gives another account's session the same list, with what works only here greyed out", () => {
    expect(shown({ paired: idle, foreign: true, accounts: ["b@x"], account: "c@x" })).toBe("✗here ✱window ✗account viewer folder ✗rename ✗export ✗import copy");
    expect(shown({ foreign: true, state: "active" })).toBe("✗attach ✱switch viewer folder ✗rename ✗export ✗import copy");
    expect(shown({ foreign: true, terminal: false })).toBe("✗here ✗window ✗window-attach ✱viewer folder ✗rename ✗export ✗import copy");
    const window = sessionOptions({ ...base, foreign: true, account: "c@x" }).options.find((o) => o.id === "window")!;
    expect(window).toMatchObject({ label: "Continue it in a new Claude Code window", detail: "claude --resume as c@x" });
    expect(sessionOptions({ ...base, foreign: true }).options.find((o) => o.id === "rename")!.disabled).toBe("only for sessions of this account");
  });

  it("opens it in another window while viewers of it run, and brings the newest to the front", () => {
    expect(shown({ paired: idle, viewers: 2 })).toBe("✱here window viewer viewer-front folder rename export import copy");
    const { options } = sessionOptions({ ...base, viewers: 2 });
    expect(options.find((o) => o.id === "viewer")!.label).toBe("Open another session viewer");
    expect(options.find((o) => o.id === "viewer-front")!.detail).toBe("the one opened last of 2");
    expect(sessionOptions({ ...base, viewers: 1, terminal: false }).options.find((o) => o.id === "viewer-front")!.disabled).toBe("no Windows Terminal or tmux");
  });

  it("names the selected action in the help line, and detaching for its own session", () => {
    expect(enterLabel({ ...base, paired: idle, state: "current" })).toBe("↵ detach…");
    expect(enterLabel({ ...base, paired: idle, state: "active" })).toBe("↵ switch");
    expect(enterLabel({ ...base, state: "active" })).toBe("↵ attach");
    expect(enterLabel({ ...base, paired: idle })).toBe("↵ resume in this Claude Code");
    expect(enterLabel({ ...base, paired: { ...idle, empty: false } })).toBe("↵ new Claude Code");
    expect(enterLabel(base)).toBe("↵ new Claude Code + attach");
    expect(enterLabel({ ...base, terminal: false })).toBe("↵ session viewer");
  });
});

const renderView = (props: Partial<Parameters<typeof SessionsView>[0]>) =>
  renderInk(<SessionsView cwd={cwd} layout={layout} visible active {...props} />, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });


/** A session of the project that runs nowhere. */
function pastSession(id: string, dir = cwd) {
  const ts = new Date(Date.now() - 60_000).toISOString();
  mkdirSync(projectDir(dir), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(projectDir(dir), `${id}.jsonl`), JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd: dir, message: { role: "user", content: "Old work" } }) + "\n");
}

/** Registers a Claude Code process (this one) as running `sessionId`. */
function runs(sessionId: string, status = "idle") {
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, status }));
}

describe("prepareConsoleInput", () => {
  it("starts PowerShell ahead and types the line it gets later, once", async () => {
    typerAnswer = "ok";
    const typer = prepareConsoleInput(42, "win32")!;
    expect(spawned[0]!.cmd).toBe("powershell.exe");
    expect(spawned[0]!.typed).toBeUndefined();
    expect(typer.ready()).toBe(true);
    expect(await typer.type(commandSteps("/resume abc"))).toBe(true);
    expect(spawned[0]!.typed).toBe(`${stepsLine(commandSteps("/resume abc"))}\n`);
    expect(typer.ready()).toBe(false);
    expect(await typer.type(commandSteps("/resume again"))).toBe(false);
  });

  it("writes the keys as one line of JSON, everything past ASCII escaped", () => {
    expect(stepsLine([["äb 🦊", 0, 0, 150]])).toBe('[["\\u00e4b \\ud83e\\udd8a",0,0,150]]');
    expect(JSON.parse(stepsLine([["äb 🦊", 0, 0, 150]]))).toEqual([["äb 🦊", 0, 0, 150]]);
  });

  it("types a prompt after what is there, a line break as \\ and Enter, the last Enter sending", () => {
    expect(promptSteps("one\ntwo")).toEqual([
      ["one\\", 0, 0, 150],
      ["\r", 13, 0, 100],
      ["two", 0, 0, 150],
      ["\r", 13, 0, 0],
    ]);
    expect(promptSteps("hi")).toEqual([
      ["hi", 0, 0, 150],
      ["\r", 13, 0, 0],
    ]);
    // A slash command clears the input first.
    expect(commandSteps("/resume x")[0]).toEqual(["\f", 0x4c, 8, 100]);
  });

  it("reports a failure, ends without typing when cancelled, and starts nothing off Windows", async () => {
    typerAnswer = "attach 6";
    expect(await prepareConsoleInput(42, "win32")!.type(commandSteps("/resume abc"))).toBe(false);
    prepareConsoleInput(42, "win32")!.cancel();
    expect(spawned[1]).toMatchObject({ killed: true, typed: undefined });
    expect(prepareConsoleInput(42, "linux")).toBeUndefined();
    expect(spawned).toHaveLength(2);
  });
});

describe("continuing a session that runs nowhere", () => {
  it.runIf(process.platform === "win32")("types /resume through the PowerShell started when the dialog opened", async () => {
    typerAnswer = "ok";
    pastSession("s1");
    const view = renderView({ paired: { claudePid: process.pid, empty: true, placement: "right" } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    // Started with the dialog, before anything is chosen.
    expect(spawned.filter((c) => c.cmd === "powershell.exe")).toHaveLength(1);
    await view.press("\r");
    await until(() => view.frame().includes("continuing it in this Claude Code"));
    expect(spawned.filter((c) => c.cmd === "powershell.exe").map((c) => c.typed)).toEqual([`${stepsLine(commandSteps("/resume s1"))}\n`]);
    view.unmount();
  });

  it.runIf(process.platform === "win32")("ends that PowerShell when another option is taken", async () => {
    pastSession("s1");
    const view = renderView({ paired: { claudePid: process.pid, empty: true } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    await view.press("2");
    await until(() => spawned.some((c) => c.args.includes("--resume")));
    expect(spawned.find((c) => c.cmd === "powershell.exe")).toMatchObject({ killed: true, typed: undefined });
    view.unmount();
  });

  it("in the viewer's Claude Code: copies /resume and moves the focus there", async () => {
    pastSession("s1");
    const view = renderView({ paired: { claudePid: process.pid, empty: true, placement: "right" } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toMatch(/› +Continue it in this Claude Code/);
    await view.press("\r");
    await until(() => view.frame().includes("copied /resume s1"));
    expect(view.written()).toContain(`\u001b]52;c;${Buffer.from("/resume s1").toString("base64")}`);
    expect(spawned).toContainEqual({ cmd: "wt", args: ["-w", "0", "move-focus", "left"] });
    view.unmount();
  });

  it("greys out continuing here while Claude works, and selects a new window", async () => {
    pastSession("s1");
    runs("own", "busy");
    const view = renderView({ paired: { claudePid: process.pid, empty: true } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toContain("Claude is working");
    expect(view.frame()).toMatch(/› +Continue it in a new Claude Code window/);
    // A disabled option is not taken, by key or digit.
    await view.press("\u001b[A");
    await view.press("1");
    await tick(100);
    expect(spawned).toEqual([]);
    await view.press("2");
    await until(() => spawned.length > 0);
    expect(spawned[0]!.args).toContain("--resume");
    view.unmount();
  });

  it("without a Claude Code: starts it, waits, then pairs with it where it runs", async () => {
    pastSession("s1");
    const started: [PairTarget, string][] = [];
    const view = renderView({ onPair: () => true, onPairStarted: (t, w) => void started.push([t, w]) });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toMatch(/› +Continue it in a new Claude Code window and attach/);
    await view.press("\r");
    await until(() => view.frame().includes("Waiting for Claude Code…"));
    expect(spawned[0]!.args.slice(0, 2)).toEqual(["-w", "cco-resume-s1"]);
    // Its hook opens no viewer of its own.
    expect(readJson<{ sessionId: string }>(pairingFile(cwd))?.sessionId).toBe("s1");
    runs("s1");
    await until(() => started.length > 0);
    expect(started).toEqual([[{ cwd, claudePid: process.pid, sessionId: "s1", transcript: join(projectDir(cwd), "s1.jsonl") }, "cco-resume-s1"]]);
    await until(() => !view.frame().includes("Waiting for Claude Code…"));
    view.unmount();
  });

  it("stops waiting on Esc and withdraws the pairing request", async () => {
    pastSession("s1");
    const view = renderView({ onPair: () => true, onPairStarted: () => {} });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    await view.press("\r");
    await until(() => view.frame().includes("Waiting for Claude Code…"));
    // The choice has closed; the progress dialog waits, and Esc cancels it.
    expect(view.frame()).toContain("Attach this viewer");
    expect(view.frame()).toContain("Esc cancel");
    expect(view.frame()).not.toContain("What to do with this session?");
    await view.press("\u001b");
    await until(() => view.frame().includes("pairing cancelled"));
    expect(existsSync(pairingFile(cwd))).toBe(false);
    view.unmount();
  });

  it("cannot continue a session of another project folder here", async () => {
    updateSettings({ sessionsFolders: "all" });
    pastSession("s1", join(tmpdir(), "cco-resume-elsewhere"));
    const view = renderView({ paired: { claudePid: process.pid, empty: true } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    expect(view.frame()).toContain("ran in cco-resume-elsewhere, not in this folder");
    expect(view.frame()).toMatch(/› +Continue it in a new Claude Code window/);
    view.unmount();
  });

});

describe("continuing a session in another account", () => {
  it("copies it there after asking and starts it under that account's folder, in a new window of its own", async () => {
    pastSession("s1");
    const own = claudeDir();
    const other = mkdtempSync(join(tmpdir(), "cco-resume-other-"));
    // The plugin is there already: nothing to install.
    mkdirSync(join(other, "plugins"), { recursive: true });
    writeFileSync(join(other, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "cco@cc-outline": [{ scope: "user" }] } }));
    const accounts = { accounts: [{ dir: own, file: "", email: "a@x" }, { dir: other, file: "", email: "b@x" }], current: { dir: own, file: "", email: "a@x" }, multiple: true, own };
    const started: [PairTarget, string][] = [];
    const view = renderInk(
      <AccountContext.Provider value={accounts}>
        <SessionsView cwd={cwd} layout={layout} visible active onPair={() => true} onPairStarted={(t, w) => void started.push([t, w])} />
      </AccountContext.Provider>,
      layout,
      { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> },
    );
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue it in b@x…"));
    await view.press("3");
    await until(() => view.frame().includes("Continue in b@x?"));
    expect(view.frame()).toContain("A copy continues in b@x");
    // The head names the session's account, this one.
    expect(view.frame()).toContain("▌ a@x · this account");
    await view.press("\r");
    await until(() => spawned.some((c) => c.cmd === "wt"));
    expect(existsSync(join(other, "projects", projectSlug(cwd), "s1.jsonl"))).toBe(true);
    const wt = spawned.find((c) => c.cmd === "wt")!;
    expect(wt.args.slice(0, 2)).toEqual(["-w", "new"]);
    expect(wt.args).toContain("--resume");
    expect(wt.args.slice(wt.args.indexOf("--config-dir"), wt.args.indexOf("--config-dir") + 2)).toEqual(["--config-dir", other]);
    // Its hook opens a viewer of its own there; this one stays where it is.
    expect(inClaudeDir(other, () => existsSync(pairingFile(cwd)))).toBe(false);
    expect(readTransfers(cwd).s1?.to?.[0]?.email).toBe("b@x");
    inClaudeDir(other, () => runs("s1"));
    await tick(100);
    expect(started).toEqual([]);
    expect(view.frame()).not.toContain("Waiting for Claude Code");
    view.unmount();
  });

  it("leaves a running session as it is: no question of closing it", async () => {
    pastSession("s1");
    runs("s1", "busy");
    const own = claudeDir();
    const other = mkdtempSync(join(tmpdir(), "cco-resume-other-"));
    const accounts = { accounts: [{ dir: own, file: "", email: "a@x" }, { dir: other, file: "", email: "b@x" }], current: { dir: own, file: "", email: "a@x" }, multiple: true, own };
    const view = renderInk(
      <AccountContext.Provider value={accounts}>
        <SessionsView cwd={cwd} layout={layout} visible active onPair={() => true} />
      </AccountContext.Provider>,
      layout,
      { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> },
    );
    await until(() => view.frame().includes("Prompts (1)") && view.frame().includes("↵ attach"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue it in b@x…"));
    await view.press("3");
    await until(() => view.frame().includes("Continue in b@x?"));
    expect(view.frame()).toContain("with the cco plugin installed there first");
    expect(view.frame()).toContain("This session and its viewer stay as they are.");
    expect(view.frame()).not.toContain("Close it and continue there");
    expect(view.frame()).not.toContain("keep it running");
    view.unmount();
  });
});

describe("Enter on a session that runs", () => {
  it("offers the viewer's own session to stay or detach, staying by default", async () => {
    pastSession("s1");
    const detached: string[] = [];
    const view = renderView({ activePath: join(projectDir(cwd), "s1.jsonl"), paired: { claudePid: process.pid, empty: false }, onDetach: () => void detached.push("s1") });
    await until(() => view.frame().includes("↵ detach…"));
    await view.press("\r");
    await until(() => view.frame().includes("this viewer's session"));
    expect(view.frame()).toMatch(/› +Stay attached/);
    // Enter twice changes nothing.
    await view.press("\r");
    await until(() => !view.frame().includes("this viewer's session"));
    expect(detached).toEqual([]);
    await view.press("\r");
    await until(() => view.frame().includes("this viewer's session"));
    await view.press("2");
    await until(() => detached.length > 0);
    expect(detached).toEqual(["s1"]);
    view.unmount();
  });

  it("switches by default for a paired viewer, which can also attach there", async () => {
    pastSession("s1");
    runs("s1");
    const attached: PairTarget[] = [];
    const view = renderView({ paired: { claudePid: 1, empty: true }, onPair: (t) => (attached.push(t), true) });
    await until(() => view.frame().includes("↵ switch"));
    await view.press("\r");
    await until(() => view.frame().includes("runs in a Claude Code"));
    expect(view.frame()).toMatch(/› +Switch to its Claude Code tab/);
    await view.press("2");
    await until(() => attached.length > 0);
    expect(attached).toEqual([{ cwd, claudePid: process.pid, sessionId: "s1", transcript: join(projectDir(cwd), "s1.jsonl") }]);
    view.unmount();
  });

  it("copies claude attach for a session the Claude Code daemon runs", async () => {
    pastSession("s1");
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", status: "idle", kind: "bg", jobId: "job7" }));
    const view = renderView({ paired: { claudePid: 1, empty: true }, onPair: () => true });
    await until(() => view.frame().includes("↵ switch"));
    await view.press("\r");
    await until(() => view.frame().includes("runs in a Claude Code"));
    expect(view.frame()).toContain("claude attach job7");
    await view.press("8");
    await until(() => view.frame().includes("copied: claude attach job7"));
    view.unmount();
  });
});

describe("opening a session's folder", () => {
  it("opens the folder it ran in, in the file manager", async () => {
    pastSession("s1");
    const view = renderView({});
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Open its folder"));
    await view.press("4");
    await until(() => spawned.some((c) => c.args[0] === cwd));
    expect(view.frame()).not.toContain("What to do with this session?");
    view.unmount();
  });
});

describe("renaming a session", () => {
  it("writes the new title into a session that runs nowhere, refusing an empty one", async () => {
    pastSession("s1");
    const view = renderView({});
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    await view.press("5");
    await until(() => view.frame().includes("Rename the session"));
    await view.press("\r");
    await until(() => view.frame().includes("The name must not be empty"));
    await view.press("Fixed login");
    await view.press("\r");
    await until(() => view.frame().includes("renamed: Fixed login"));
    const lines = readFileSync(join(projectDir(cwd), "s1.jsonl"), "utf8").trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "custom-title", customTitle: "Fixed login", sessionId: "s1" });
    view.unmount();
  });

  it("fills in the title it has, and writes nothing when it stays", async () => {
    pastSession("s1");
    const file = join(projectDir(cwd), "s1.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ type: "custom-title", customTitle: "Old name", sessionId: "s1" }) + "\n");
    const before = readFileSync(file, "utf8");
    const view = renderView({});
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    await view.press("5");
    await until(() => view.frame().includes("› Old name"));
    await view.press("\r");
    await until(() => !view.frame().includes("Rename the session"));
    expect(readFileSync(file, "utf8")).toBe(before);
    view.unmount();
  });

  it("greys it out for a running session", async () => {
    pastSession("s1");
    runs("s1");
    const view = renderView({ onPair: () => true });
    await until(() => view.frame().includes("↵ attach"));
    await view.press("\r");
    await until(() => view.frame().includes("runs in a Claude Code"));
    expect(view.frame()).toContain("it runs: use /rename in its Claude Code");
    await view.press("5");
    await tick(100);
    expect(view.frame()).not.toContain("Rename the session");
    view.unmount();
  });
});

describe("a viewer of a session in a window of its own", () => {
  afterEach(() => rmSync(sessionViewersDir(), { recursive: true, force: true }));

  it("opens one, then counts the running ones and brings the newest to the front", async () => {
    pastSession("s1");
    const view = renderView({});
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Open it in a session viewer"));
    await view.press("3");
    await until(() => spawned.some((c) => c.args.includes("--session")));
    const call = spawned.find((c) => c.args.includes("--session"))!;
    expect(call.cmd).toBe("wt");
    expect(call.args[1]).toMatch(/^cco-view-/);
    expect(call.args).toEqual(expect.arrayContaining(["watch", "--session", "s1", "--cwd", cwd, "--window", call.args[1]]));
    await until(() => view.frame().includes("opened in a new window"));

    // This process stands in for the viewer started there.
    mkdirSync(sessionViewersDir(), { recursive: true });
    writeFileSync(join(sessionViewersDir(), `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", configDir: claudeDir(), window: "cco-view-test", started: Date.now() }));
    await until(() => view.frame().includes("1 session viewer open"));
    expect(view.frame()).toContain("◎ ");
    await view.press("\r");
    await until(() => view.frame().includes("Bring its session viewer to the front"));
    expect(view.frame()).toContain("Open another session viewer");
    await view.press("4");
    await until(() => spawned.some((c) => c.args.includes("focus-tab")));
    expect(spawned.find((c) => c.args.includes("focus-tab"))!.args).toEqual(["-w", "cco-view-test", "focus-tab", "-t", "0"]);
    view.unmount();
  });
});

describe("renameSession", () => {
  it("appends the entry on a line of its own, also after a transcript without a final line break", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cco-rename-")), "s.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", uuid: "u", message: { role: "user", content: "hi" } }));
    renameSession(file, "s", "New");
    const parser = new TranscriptParser();
    parser.push(readFileSync(file, "utf8"));
    expect(parser.title).toBe("New");
    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(3);
  });
});
