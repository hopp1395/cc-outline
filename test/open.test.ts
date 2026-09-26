import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: { cmd: string; args: string[] }[] = [];
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return { unref: () => {} };
  },
}));

const { resumeInNewTab } = await import("../src/open.js");

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
    expect(spawned).toEqual([
      {
        cmd: "wt",
        args: ["-w", "0", "new-tab", "--title", "orders", "-d", "W:\\repo", "cmd", "/k", "claude", "--resume", "abc"],
      },
    ]);
  });

  it("opens a tmux window that keeps a shell afterwards", () => {
    process.env.TMUX = "/tmp/tmux";
    process.env.SHELL = "/bin/zsh";
    expect(resumeInNewTab("abc", "/repo", "orders")).toMatch(/tmux window/);
    expect(spawned[0]).toEqual({
      cmd: "tmux",
      args: ["new-window", "-n", "orders", "-c", "/repo", "claude --resume 'abc'; exec /bin/zsh"],
    });
  });

  it("names the command when no supported terminal is found", () => {
    expect(resumeInNewTab("abc", "/repo", "orders")).toBe("no Windows Terminal or tmux: run claude --resume abc in /repo");
    expect(spawned).toEqual([]);
  });
});
