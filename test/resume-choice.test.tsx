import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick, until } from "./helpers/ink.js";
import { proc } from "../src/proc.js";
import { prepareConsoleInput } from "../src/switchSession.js";
import { claudeDir, pairingFile, projectDir, readJson } from "../src/transcript/locate.js";
import { TranscriptParser, type Turn } from "../src/transcript/parse.js";
import { renameSession } from "../src/transcript/rename.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { enterLabel, isEmptySession, sessionOptions } from "../src/tui/resumeChoice.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import type { PairTarget } from "../src/viewer.js";

const spawned: { cmd: string; args: string[]; typed?: string; killed?: boolean }[] = [];
/** What a started PowerShell prints once it got its line; "ok" types, anything else fails. */
let typerAnswer = "";
const real = { ...proc };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    const call: (typeof spawned)[number] = { cmd, args };
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
const base: Situation = { state: "inactive", terminal: true, command: "claude --resume s1" };
const idle = { empty: true, activity: "idle" as const, method: "keys" as const };
/** The option ids, the selected one marked with ✱ and disabled ones with ✗. */
const shown = (s: Partial<Situation>) => {
  const { options, initial } = sessionOptions({ ...base, ...s });
  return options.map((o, i) => `${i === initial ? "✱" : ""}${o.disabled ? "✗" : ""}${o.id}`).join(" ");
};

describe("sessionOptions", () => {
  it("offers its own session to stay or detach", () => {
    expect(shown({ paired: idle, state: "current" })).toBe("✱stay detach ✗rename copy");
  });

  it("switches to a running session by default, and attaches the viewer there if that Claude Code has none", () => {
    expect(shown({ paired: idle, state: "active" })).toBe("✱switch attach ✗rename copy");
    expect(shown({ paired: idle, state: "active", attachBlocked: "it has a viewer of its own" })).toBe("✱switch ✗attach ✗rename copy");
    // A viewer of no Claude Code attaches by default.
    expect(shown({ state: "active" })).toBe("✱attach switch ✗rename copy");
    expect(shown({ state: "active", attachBlocked: "it has a viewer of its own" })).toBe("✗attach ✱switch ✗rename copy");
  });

  it("continues a session that runs nowhere here when the viewer's Claude Code has no prompt yet, else in a new window", () => {
    expect(shown({ paired: idle })).toBe("✱here window window-attach rename copy");
    expect(shown({ paired: { ...idle, empty: false } })).toBe("here ✱window window-attach rename copy");
    // Versions without a status count as free.
    expect(shown({ paired: { empty: true, method: "clipboard" } })).toBe("✱here window window-attach rename copy");
    expect(shown({})).toBe("✱window-attach window rename copy");
  });

  it("greys out continuing here while Claude works or waits, and for another project folder", () => {
    for (const activity of ["busy", "waiting"] as const) expect(shown({ paired: { ...idle, activity } })).toBe("✗here ✱window window-attach rename copy");
    const { options } = sessionOptions({ ...base, paired: idle, otherFolder: "other" });
    expect(options[0]!.disabled).toBe("ran in other, not in this folder");
  });

  it("falls back to copying the command when nothing else can be done", () => {
    expect(shown({ paired: { ...idle, activity: "busy" }, terminal: false })).toBe("✗here ✗window ✗window-attach rename ✱copy");
    expect(shown({ folderMissing: true })).toBe("✗window-attach ✗window rename ✱copy");
    expect(shown({ state: "active", terminal: false, attachBlocked: "it has a viewer of its own" })).toBe("✗attach ✗switch ✗rename ✱copy");
  });

  it("names the selected action in the help line, and detaching for its own session", () => {
    expect(enterLabel({ ...base, paired: idle, state: "current" })).toBe("↵ detach…");
    expect(enterLabel({ ...base, paired: idle, state: "active" })).toBe("↵ switch");
    expect(enterLabel({ ...base, state: "active" })).toBe("↵ attach");
    expect(enterLabel({ ...base, paired: idle })).toBe("↵ resume here");
    expect(enterLabel({ ...base, paired: { ...idle, empty: false } })).toBe("↵ new window");
    expect(enterLabel(base)).toBe("↵ start + attach");
    expect(enterLabel({ ...base, terminal: false })).toBe("↵ copy");
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
    expect(await typer.type("/resume abc")).toBe(true);
    expect(spawned[0]!.typed).toBe("/resume abc\n");
    expect(await typer.type("/resume again")).toBe(false);
  });

  it("reports a failure, ends without typing when cancelled, and starts nothing off Windows", async () => {
    typerAnswer = "attach 6";
    expect(await prepareConsoleInput(42, "win32")!.type("/resume abc")).toBe(false);
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
    await until(() => view.frame().includes("Continue this session where?"));
    // Started with the dialog, before anything is chosen.
    expect(spawned.filter((c) => c.cmd === "powershell.exe")).toHaveLength(1);
    await view.press("\r");
    await until(() => view.frame().includes("continuing it in this Claude Code"));
    expect(spawned.filter((c) => c.cmd === "powershell.exe").map((c) => c.typed)).toEqual(["/resume s1\n"]);
    view.unmount();
  });

  it.runIf(process.platform === "win32")("ends that PowerShell when another option is taken", async () => {
    pastSession("s1");
    const view = renderView({ paired: { claudePid: process.pid, empty: true } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue this session where?"));
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
    await until(() => view.frame().includes("Continue this session where?"));
    expect(view.frame()).toMatch(/› +Continue it here/);
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
    await until(() => view.frame().includes("Continue this session where?"));
    expect(view.frame()).toContain("Claude is working");
    expect(view.frame()).toMatch(/› +Continue it in a new window/);
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
    await until(() => view.frame().includes("Continue this session where?"));
    expect(view.frame()).toMatch(/› +Start it and attach the viewer/);
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
    await until(() => view.frame().includes("Continue this session where?"));
    await view.press("\r");
    await until(() => view.frame().includes("Waiting for Claude Code…"));
    // The choice has closed; the progress dialog waits, and Esc cancels it.
    expect(view.frame()).toContain("Attach the viewer");
    expect(view.frame()).toContain("Esc cancel");
    expect(view.frame()).not.toContain("Continue this session where?");
    await view.press("\u001b");
    await until(() => view.frame().includes("pairing cancelled"));
    expect(existsSync(pairingFile(cwd))).toBe(false);
    view.unmount();
  });

  it("cannot continue a session of another project folder here", async () => {
    pastSession("s1", join(tmpdir(), "cco-resume-elsewhere"));
    const view = renderView({ paired: { claudePid: process.pid, empty: true } });
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue this session where?"));
    expect(view.frame()).toContain("ran in cco-resume-elsewhere, not in this folder");
    expect(view.frame()).toMatch(/› +Continue it in a new window/);
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
    await until(() => view.frame().includes("This viewer's session"));
    expect(view.frame()).toMatch(/› +Stay attached/);
    // Enter twice changes nothing.
    await view.press("\r");
    await until(() => !view.frame().includes("This viewer's session"));
    expect(detached).toEqual([]);
    await view.press("\r");
    await until(() => view.frame().includes("This viewer's session"));
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
    await until(() => view.frame().includes("This session runs in a Claude Code"));
    expect(view.frame()).toMatch(/› +Switch to its tab/);
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
    await until(() => view.frame().includes("This session runs in a Claude Code"));
    expect(view.frame()).toContain("claude attach job7");
    await view.press("4");
    await until(() => view.frame().includes("copied: claude attach job7"));
    view.unmount();
  });
});

describe("renaming a session", () => {
  it("writes the new title into a session that runs nowhere, refusing an empty one", async () => {
    pastSession("s1");
    const view = renderView({});
    await until(() => view.frame().includes("Prompts (1)"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue this session where?"));
    await view.press("3");
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
    await until(() => view.frame().includes("Continue this session where?"));
    await view.press("3");
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
    await until(() => view.frame().includes("This session runs in a Claude Code"));
    expect(view.frame()).toContain("it runs: use /rename in its Claude Code");
    await view.press("3");
    await tick(100);
    expect(view.frame()).not.toContain("Rename the session");
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
