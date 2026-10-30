import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proc } from "../src/proc.js";
import { commandSteps, keysInClaude, paneOf, parsePanes, resumeHereMethod, resumeSlashCommand, typesIntoConsole, weztermPaneOf, type KeyStep } from "../src/switchSession.js";

describe("switching to a running session", () => {
  const panes = parsePanes("100 %1\n200 %2\n\n");

  it("reads tmux's panes by process id", () => {
    expect(panes).toEqual(new Map([[100, "%1"], [200, "%2"]]));
  });

  it("finds the pane of the process or of its nearest ancestor", async () => {
    const parents = new Map([[300, 250], [250, 200], [200, 1]]);
    const parentOf = async (pid: number) => parents.get(pid);
    expect(await paneOf(100, panes, parentOf)).toBe("%1");
    expect(await paneOf(300, panes, parentOf)).toBe("%2");
    expect(await paneOf(400, panes, parentOf)).toBeUndefined();
  });
});

describe("continuing a session in the viewer's Claude Code", () => {
  it("types the command in under tmux, WezTerm and on Windows, else copies it", () => {
    expect(resumeHereMethod("tmux", "linux")).toBe("keys");
    expect(resumeHereMethod("wezterm", "darwin")).toBe("keys");
    expect(resumeHereMethod("wt", "win32")).toBe("keys");
    expect(resumeHereMethod(undefined, "win32")).toBe("keys");
    expect(resumeHereMethod(undefined, "darwin")).toBe("clipboard");
    expect(resumeSlashCommand("abc")).toBe("/resume abc");
  });

  it("types through the console only where no pane takes the keys", () => {
    expect(typesIntoConsole("wt")).toBe(true);
    expect(typesIntoConsole(undefined)).toBe(true);
    expect(typesIntoConsole("tmux")).toBe(false);
    expect(typesIntoConsole("wezterm")).toBe(false);
  });
});

describe("WezTerm panes", () => {
  const calls: { args: string[]; input?: string }[] = [];
  const real = { ...proc };
  const saved = process.env.WEZTERM_PANE;
  let dir: string;
  beforeAll(() => {
    proc.execFile = ((_cmd: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
      const call: { args: string[]; input?: string } = { args };
      calls.push(call);
      // send-text reads the text from stdin, which is written after the call returns.
      queueMicrotask(() => done(null, ""));
      return { stdin: { end: (input: string) => (call.input = input) } };
    }) as never;
  });
  afterAll(() => {
    Object.assign(proc, real);
  });
  beforeEach(() => {
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "cco-wezterm-"));
    process.env.WEZTERM_PANE = "1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WEZTERM_PANE;
    else process.env.WEZTERM_PANE = saved;
  });

  it("finds a Claude Code's pane in the state file its hook wrote, in any project", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "C--a.claude-42.json"), JSON.stringify({ session_id: "s", wezterm_pane: "5" }));
    writeFileSync(join(dir, "C--b.claude-43.json"), JSON.stringify({ session_id: "t" }));
    expect(weztermPaneOf(42, dir)).toBe("5");
    expect(weztermPaneOf(43, dir)).toBeUndefined();
    expect(weztermPaneOf(44, join(dir, "missing"))).toBeUndefined();
  });

  it("types each step's characters into the pane as typed, not pasted", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "cco-wezterm-cfg-"));
    mkdirSync(join(cfg, "cco"));
    writeFileSync(join(cfg, "cco", "C--a.claude-42.json"), JSON.stringify({ session_id: "s", wezterm_pane: "5" }));
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const steps = commandSteps("/resume abc").map(([chars, vk, ctrl]): KeyStep => [chars, vk, ctrl, 0]);
      expect(await keysInClaude(42, steps, undefined, true)).toEqual({ typed: true, message: "typed" });
      expect(calls.map((c) => [c.args.slice(1).join(" "), c.input])).toEqual([
        ["send-text --pane-id 5 --no-paste", "\f"],
        ["send-text --pane-id 5 --no-paste", "/resume abc"],
        ["send-text --pane-id 5 --no-paste", "\r"],
        ["activate-pane --pane-id 5", undefined],
      ]);
      expect(await keysInClaude(99, steps)).toEqual({ typed: false, message: "its WezTerm pane is not known" });
    } finally {
      process.env.CLAUDE_CONFIG_DIR = before;
    }
  });
});
