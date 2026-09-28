import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSessionPlacement } from "../src/sessionViews.js";
import { updateSettings } from "../src/settings.js";
import { claudeFile, writeJson } from "../src/transcript/locate.js";
import { registerViewer, unregisterViewer } from "../src/viewer.js";

const spawned: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; windowsHide?: boolean }[] = [];
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
    spawned.push({ cmd, args, env: opts?.env, windowsHide: opts?.windowsHide });
    return { unref: () => {} };
  },
}));

const { independentEnv, moveViewer, openInDefaultApp, openPane, resumeInNewTab } = await import("../src/open.js");

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

describe("openPane", () => {
  // A project no viewer runs for, and settings of its own.
  const cwd = mkdtempSync(join(tmpdir(), "cco-open-"));
  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-open-cfg-"));
  });
  // The terminal command split into what comes before the viewer (node, cli, watch …) and the rest.
  const call = (i = 0) => {
    const { cmd, args } = spawned[i];
    const at = args.indexOf(process.execPath);
    return { cmd, before: args.slice(0, at), viewer: args.slice(at).join(" ") };
  };

  it("docks right in Windows Terminal, as the setting says by default", () => {
    process.env.WT_SESSION = "x";
    expect(openPane(cwd, "chat", { keepFocus: true, claudePid: 42 })).toBe("Opened cco chat in a Windows Terminal pane.");
    const { cmd, before, viewer } = call();
    expect(cmd).toBe("wt");
    expect(before).toEqual(["-w", "0", "split-pane", "-V", "--title", "cco", "-d", cwd]);
    expect(viewer).toMatch(/ --placement right --unfocused --claude-pid 42 ; move-focus left$/);
  });

  it("opens a window of its own when Claude Code has no tab (no WT_SESSION)", () => {
    process.env.WT_PROFILE_ID = "{profile}";
    expect(openPane(cwd, "chat", { keepFocus: true, claudePid: 42 })).toMatch(/window: this Claude Code has no terminal tab/);
    const { before, viewer } = call();
    expect(before).toEqual(["-w", "cco-42", "new-tab", "--title", "cco", "-d", cwd]);
    expect(viewer).toMatch(/ --placement window --claude-pid 42$/);
    // A pane's hidden start would keep the window wt has to create invisible.
    expect(spawned[0].windowsHide).toBe(false);
  });

  it("docks left by swapping the new pane over, and returns the focus to the right", () => {
    process.env.WT_SESSION = "x";
    expect(openPane(cwd, "git", { keepFocus: true, placement: "left" })).toMatch(/pane on the left\.$/);
    expect(call().viewer).toMatch(/ --placement left --unfocused ; swap-pane left ; move-focus right$/);
  });

  it("opens a window per Claude Code process, which takes the focus", () => {
    process.env.WT_SESSION = "x";
    expect(openPane(cwd, "plan", { keepFocus: true, claudePid: 42, placement: "window" })).toMatch(/Windows Terminal window/);
    const { before, viewer } = call();
    expect(before).toEqual(["-w", "cco-42", "new-tab", "--title", "cco", "-d", cwd]);
    expect(viewer).not.toMatch(/--unfocused|move-focus/);
    // Started hidden, Windows Terminal would keep the new window hidden.
    expect(spawned[0].windowsHide).toBe(false);
  });

  it("uses tmux: -b for left, a tmux window for window", () => {
    process.env.TMUX = "/tmp/tmux";
    openPane(cwd, "chat", { placement: "left" });
    openPane(cwd, "chat", { keepFocus: true, placement: "window" });
    expect(spawned[0].args.slice(0, 3)).toEqual(["split-window", "-h", "-b"]);
    expect(spawned[1].args.slice(0, 4)).toEqual(["new-window", "-d", "-n", "cco"]);
  });

  it("takes the placement of the process's session, else the setting", () => {
    process.env.WT_SESSION = "x";
    updateSettings({ placement: "left" });
    openPane(cwd, "chat", { claudePid: 7 });
    writeJson(claudeFile(cwd, 7), { session_id: "s1", transcript_path: "", cwd, updated: "" });
    saveSessionPlacement(cwd, "s1", "window");
    openPane(cwd, "chat", { claudePid: 7 });
    expect(spawned[0].args.join(" ")).toContain("swap-pane left");
    expect(spawned[1].args.slice(0, 3)).toEqual(["-w", "cco-7", "new-tab"]);
  });

  it("switches a running viewer's view instead, unless it replaces it", () => {
    process.env.WT_SESSION = "x";
    registerViewer(cwd, "chat", 9);
    expect(openPane(cwd, "git", { claudePid: 9 })).toMatch(/already open/);
    expect(spawned).toEqual([]);
    openPane(cwd, "git", { claudePid: 9, replace: true });
    expect(spawned).toHaveLength(1);
    unregisterViewer(cwd, 9);
  });

  it("moves the viewer through cco open, which waits for this process to exit", () => {
    expect(moveViewer(cwd, "chat", "left", 42)).toBe(false);
    process.env.WT_SESSION = "x";
    expect(moveViewer(cwd, "chat", "left", 42)).toBe(true);
    const { cmd, args } = spawned[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1).join(" ")).toBe(`open --cwd ${cwd} --view chat --placement left --after-pid ${process.pid} --claude-pid 42`);
  });
});

