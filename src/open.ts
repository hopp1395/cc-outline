import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Placement } from "./settings.js";
import { resolvePlacement } from "./sessionViews.js";
import { claudeFile, readActive, readJson, type ActiveSession } from "./transcript/locate.js";
import { ranFromQueue } from "./transcript/queue.js";
import type { Mode } from "./tui/layout.js";
import { requestView, runningViewer } from "./viewer.js";

const VIEW_NAMES: Record<Mode, string> = { chat: "chat", git: "git changes", plan: "plan", sessions: "sessions", settings: "settings", monitor: "monitor" };

/**
 * The CLI to start the viewer and `cco open` with. This module can end up in a
 * chunk of its own next to `dist/cli.js` (tsup splits off the viewer), so its
 * own file is not the CLI.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

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
  /** An entry to select in the view (`releases` in Settings). */
  select?: string;
  /** The viewer reopens after an update to this version, and says so. */
  updatedTo?: string;
  /** The command was typed while Claude was working and ran only at the end of the turn (`openedFromQueue`). */
  queued?: boolean;
}

/**
 * Opens the viewer next to the current terminal pane (Windows Terminal or
 * tmux): docked right or left, or in a window of its own.
 */
export function openPane(cwd: string, view: Mode, opts: OpenOptions = {}): string {
  const { claudePid } = opts;
  if (!opts.replace && runningViewer(cwd, claudePid) !== undefined) {
    requestView(cwd, view, claudePid, opts.select);
    return `cco is already open; switched it to the ${VIEW_NAMES[view]} view.`;
  }
  const terminal = detectTerminal();
  const chosen = opts.placement ?? resolvePlacement(cwd, sessionOfProcess(cwd, claudePid)?.session_id);
  // wt finds the window of the calling tab through WT_SESSION. A Claude Code without it (restarted
  // itself, or a session run by the Claude Code daemon) has no tab to dock to: wt would open a new
  // window anyway, hidden by windowsHide. Open the viewer in a window of its own instead.
  const tabless = terminal === "wt" && !process.env.WT_SESSION && chosen !== "window";
  // split-pane splits the tab active now, which after a wait may be another one (the user moved on).
  // wt cannot name the calling tab, so a queued command opens the window of this process instead.
  const away = terminal === "wt" && !tabless && opts.queued === true && chosen !== "window";
  const placement = tabless || away ? "window" : chosen;

  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  const viewer = [process.execPath, CLI, "watch", "--cwd", cwd, "--view", view, "--placement", placement];
  // The viewer cannot ask the terminal whether it has the focus; tell it.
  const unfocused = opts.keepFocus && !(placement === "window" && terminal === "wt");
  if (unfocused) viewer.push("--unfocused");
  if (opts.select) viewer.push("--select", opts.select);
  if (opts.updatedTo) viewer.push("--updated-to", opts.updatedTo);
  // The viewer follows the session of this Claude Code process, not whichever session of the project is newest.
  if (claudePid) viewer.push("--claude-pid", String(claudePid));

  const where = PLACE_NAMES[placement];
  if (terminal === "tmux") {
    const cmd = viewer.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    // -d leaves the current pane active; -b puts the new pane before (left of) it.
    const keep = opts.keepFocus ? ["-d"] : [];
    // Claude Code's own pane, not the one active now (a queued command runs only at the end of the turn).
    const pane = process.env.TMUX_PANE;
    const args =
      placement === "window"
        ? ["new-window", ...keep, ...(pane ? ["-a", "-t", pane] : []), "-n", "cco", "-c", cwd, cmd]
        : ["split-window", "-h", ...(placement === "left" ? ["-b"] : []), ...keep, ...(pane ? ["-t", pane] : []), "-c", cwd, cmd];
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
    if (tabless) return `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal window: this Claude Code has no terminal tab to dock to.`;
    if (away) return `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal window: Claude was busy, and the pane would have opened in whichever tab is active now. Press p in it to dock it.`;
    return placement === "window" ? `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal window.` : `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal pane${where}.`;
  }
  return `No supported terminal detected (Windows Terminal or tmux). Run in another terminal: cco watch --view ${view} --cwd "${cwd}"`;
}

/** The session the Claude Code process `claudePid` (else the project) is in, from the hook's state files. */
function sessionOfProcess(cwd: string, claudePid: number | undefined): ActiveSession | undefined {
  const own = claudePid ? readJson<ActiveSession>(claudeFile(cwd, claudePid)) : undefined;
  return own ?? readActive(cwd);
}

/** Whether `cco open` runs from a command that waited in Claude Code's queue for the turn to end (`ranFromQueue`). */
export function openedFromQueue(cwd: string, claudePid: number | undefined): boolean {
  return ranFromQueue(sessionOfProcess(cwd, claudePid)?.transcript_path);
}

/**
 * Moves the running viewer (this process) to `placement`: starts `cco open`
 * detached, which waits until this process has exited and then opens the
 * viewer there. The caller quits right after. False without a supported terminal.
 * After an update (`updatedTo`), the CLI started is the new one.
 */
export function moveViewer(cwd: string, view: Mode, placement: Placement, claudePid: number | undefined, updatedTo?: string): boolean {
  if (!detectTerminal()) return false;
  const args = [CLI, "open", "--cwd", cwd, "--view", view, "--placement", placement, "--after-pid", String(process.pid)];
  if (claudePid) args.push("--claude-pid", String(claudePid));
  if (updatedTo) args.push("--updated-to", updatedTo);
  spawn(process.execPath, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  return true;
}
