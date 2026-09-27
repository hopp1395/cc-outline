import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    spawned.push({ cmd, args, env: opts?.env });
    return { unref: () => {} };
  },
}));

const { independentEnv, openInDefaultApp, resumeInNewTab } = await import("../src/open.js");

const saved = { ...process.env };
beforeEach(() => {
  spawned.length = 0;
  delete process.env.TMUX;
  delete process.env.WT_SESSION;
  delete process.env.WT_PROFILE_ID;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("resumeInNewTab", () => {
  it("opens a Windows Terminal tab in the session's folder", () => {
    process.env.WT_SESSION = "x";
    expect(resumeInNewTab("abc", "W:\\repo", "orders")).toMatch(/Windows Terminal tab/);
    expect(spawned.map(({ cmd, args }) => ({ cmd, args }))).toEqual([
      {
        cmd: "wt",
        args: ["-w", "0", "new-tab", "--title", "orders", "-d", "W:\\repo", "cmd", "/k", "claude", "--resume", "abc"],
      },
    ]);
  });

  it("does not pass on the variables of the Claude Code the viewer was opened from", () => {
    process.env.WT_SESSION = "x";
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.CLAUDE_PID = "123";
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    resumeInNewTab("abc", "W:\\repo", "orders");
    const env = spawned[0].env!;
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_PID).toBeUndefined();
    // Settings the user made stay.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/cfg");
    expect(env.WT_SESSION).toBe("x");
  });

  it("opens a tmux window that clears them and keeps a shell afterwards", () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.SHELL = "/bin/zsh";
    expect(resumeInNewTab("abc", "/repo", "orders")).toMatch(/tmux window/);
    const [cmd] = spawned[0].args.slice(-1);
    expect(spawned[0].args.slice(0, -1)).toEqual(["new-window", "-n", "orders", "-c", "/repo"]);
    expect(cmd).toMatch(/^unset .*CLAUDE_CODE_CHILD_SESSION.*; claude --resume 'abc'; exec \/bin\/zsh$/);
  });

  it("names the command when no supported terminal is found", () => {
    expect(resumeInNewTab("abc", "/repo", "orders")).toBe("no Windows Terminal or tmux: run claude --resume abc in /repo");
    expect(spawned).toEqual([]);
  });
});

describe("openInDefaultApp", () => {
  it("hands the file to the system's default app", () => {
    openInDefaultApp("C:\\tmp\\a.png", "win32");
    openInDefaultApp("/tmp/a.png", "darwin");
    openInDefaultApp("/tmp/a.png", "linux");
    expect(spawned.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ["explorer.exe", "C:\\tmp\\a.png"],
      ["open", "/tmp/a.png"],
      ["xdg-open", "/tmp/a.png"],
    ]);
  });
});

describe("independentEnv", () => {
  it("drops session-bound variables in any spelling and keeps the rest", () => {
    const env = independentEnv({ ClaudeCode: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/bin" });
    expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/bin" });
  });
});
