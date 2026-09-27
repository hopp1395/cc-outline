import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Placement } from "./settings.js";
import { resolvePlacement } from "./sessionViews.js";
import { claudeFile, readActive, readJson, type ActiveSession } from "./transcript/locate.js";
import type { Mode } from "./tui/layout.js";
import { requestView, runningViewer } from "./viewer.js";

const VIEW_NAMES: Record<Mode, string> = { chat: "chat", git: "git changes", plan: "plan", sessions: "sessions", settings: "settings" };

export type Terminal = "tmux" | "wt";

/**
 * The terminal multiplexer the current process runs in. Windows Terminal sets
 * WT_SESSION and WT_PROFILE_ID; WT_SESSION can be missing (e.g. after Claude
 * Code restarted itself), so either one counts.
 */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): Terminal | undefined {
  if (env.TMUX) return "tmux";
  if (env.WT_SESSION || env.WT_PROFILE_ID) return "wt";
  return undefined;
}

/**
 * Variables Claude Code sets for its own child processes. The viewer inherits
 * them from the Claude Code it was opened from; a Claude Code started with
 * them thinks it is a child session and, among other things, does not save
 * its transcript. Settings a user sets themselves (CLAUDE_CONFIG_DIR,
 * CLAUDE_CODE_USE_BEDROCK, …) are not in this list and stay.
 */
const SESSION_BOUND_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
];

/** `env` without the variables that tie a process to the Claude Code session it was started from. */
export function independentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  // Windows environment names are case-insensitive, and Node keeps the original spelling.
  for (const key of Object.keys(clean)) if (SESSION_BOUND_VARS.includes(key.toUpperCase())) delete clean[key];
  return clean;
}

/** Opens `file` in the app the system uses for it (e.g. an image viewer), without waiting for it. */
export function openInDefaultApp(file: string, platform: NodeJS.Platform = process.platform): void {
  // explorer.exe hands the file to its default app, with no shell quoting involved.
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [file], { stdio: "ignore", detached: true, windowsHide: true });
  child.on?.("error", () => {});
  child.unref();
}

/**
 * Continues a session with `claude --resume` in a new tab (Windows Terminal)
 * or window (tmux), in the folder it ran in. The shell stays open after
 * Claude Code exits. Returns what happened, for the help line.
 * The new Claude Code must not inherit the variables of the Claude Code this
 * viewer was opened from (see `independentEnv`).
 */
export function resumeInNewTab(sessionId: string, dir: string, title: string): string {
  const terminal = detectTerminal();
  if (terminal === "wt") {
    // cmd /k finds claude whether it is an .exe or an npm .cmd shim, and keeps the tab open afterwards.
    const args = ["-w", "0", "new-tab", "--title", title, "-d", dir, "cmd", "/k", "claude", "--resume", sessionId];
    // Windows Terminal starts the tab with the environment of the wt call.
    spawn("wt", args, { stdio: "ignore", detached: true, windowsHide: true, env: independentEnv() }).unref();
    return "started in a new Windows Terminal tab";
  }
  if (terminal === "tmux") {
    const shell = process.env.SHELL || "sh";
    // tmux takes the environment from its server, which may itself have been started inside Claude Code.
    const cmd = `unset ${SESSION_BOUND_VARS.join(" ")}; claude --resume '${sessionId.replace(/'/g, "")}'; exec ${shell}`;
    spawn("tmux", ["new-window", "-n", title, "-c", dir, cmd], { stdio: "ignore", detached: true }).unref();
    return "started in a new tmux window";
  }
  return `no Windows Terminal or tmux: run claude --resume ${sessionId} in ${dir}`;
}

const PLACE_NAMES: Record<Placement, string> = { right: "", left: " on the left", window: " in a window of its own" };

export interface OpenOptions {
  /** Leave the keyboard focus where it is (in Claude Code); not possible for a Windows Terminal window. */
  keepFocus?: boolean;
  /** The Claude Code process the viewer belongs to: an open viewer is reused only if it is that process's own. */
  claudePid?: number;
  /** Where to open; default: the placement of the process's session, else the setting (`resolvePlacement`). */
  placement?: Placement;
  /** Open a new viewer even if one runs, because it is about to quit (moving with p). */
  replace?: boolean;
}

/**
 * Opens the viewer next to the current terminal pane (Windows Terminal or
 * tmux): docked right or left, or in a window of its own.
 */
export function openPane(cwd: string, view: Mode, opts: OpenOptions = {}): string {
  const { claudePid } = opts;
  if (!opts.replace && runningViewer(cwd, claudePid) !== undefined) {
    requestView(cwd, view, claudePid);
    return `cco is already open; switched it to the ${VIEW_NAMES[view]} view.`;
  }
  const placement = opts.placement ?? resolvePlacement(cwd, sessionOfProcess(cwd, claudePid));

  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  const viewer = [process.execPath, fileURLToPath(import.meta.url), "watch", "--cwd", cwd, "--view", view, "--placement", placement];
  // The viewer cannot ask the terminal whether it has the focus; tell it.
  const unfocused = opts.keepFocus && !(placement === "window" && detectTerminal() === "wt");
  if (unfocused) viewer.push("--unfocused");
  // The viewer follows the session of this Claude Code process, not whichever session of the project is newest.
  if (claudePid) viewer.push("--claude-pid", String(claudePid));

  const terminal = detectTerminal();
  const where = PLACE_NAMES[placement];
  if (terminal === "tmux") {
    const cmd = viewer.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    // -d leaves the current pane active; -b puts the new pane before (left of) it.
    const keep = opts.keepFocus ? ["-d"] : [];
    const args =
      placement === "window"
        ? ["new-window", ...keep, "-n", "cco", "-c", cwd, cmd]
        : ["split-window", "-h", ...(placement === "left" ? ["-b"] : []), ...keep, "-c", cwd, cmd];
    spawn("tmux", args, { stdio: "ignore", detached: true }).unref();
    return placement === "window" ? `Opened cco ${VIEW_NAMES[view]} in a tmux window.` : `Opened cco ${VIEW_NAMES[view]} in a tmux pane${where}.`;
  }
  if (terminal === "wt") {
    let args: string[];
    if (placement === "window") {
      // A window per Claude Code process: wt creates it under this name, or adds a tab if it still exists.
      args = ["-w", claudePid ? `cco-${claudePid}` : "cco", "new-tab", "--title", "cco", "-d", cwd, ...viewer];
    } else {
      // split-pane only opens to the right; swap-pane moves the new (active) pane to the left.
      args = ["-w", "0", "split-pane", "-V", "--title", "cco", "-d", cwd, ...viewer];
      if (placement === "left") args.push(";", "swap-pane", "left");
      if (opts.keepFocus) args.push(";", "move-focus", placement === "left" ? "right" : "left");
    }
    // windowsHide asks Windows to start hidden, which Windows Terminal applies to a new window: only for panes.
    spawn("wt", args, { stdio: "ignore", detached: true, windowsHide: placement !== "window" }).unref();
    return placement === "window" ? `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal window.` : `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal pane${where}.`;
  }
  return `No supported terminal detected (Windows Terminal or tmux). Run in another terminal: cco watch --view ${view} --cwd "${cwd}"`;
}

/** The session the Claude Code process `claudePid` (else the project) is in, from the hook's state files. */
function sessionOfProcess(cwd: string, claudePid: number | undefined): string | undefined {
  const own = claudePid ? readJson<ActiveSession>(claudeFile(cwd, claudePid)) : undefined;
  return (own ?? readActive(cwd))?.session_id;
}

/**
 * Moves the running viewer (this process) to `placement`: starts `cco open`
 * detached, which waits until this process has exited and then opens the
 * viewer there. The caller quits right after. False without a supported terminal.
 */
export function moveViewer(cwd: string, view: Mode, placement: Placement, claudePid: number | undefined): boolean {
  if (!detectTerminal()) return false;
  const args = [fileURLToPath(import.meta.url), "open", "--cwd", cwd, "--view", view, "--placement", placement, "--after-pid", String(process.pid)];
  if (claudePid) args.push("--claude-pid", String(claudePid));
  spawn(process.execPath, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  return true;
}
