import { proc } from "./proc.js";
import { requestRcViewerSelect, type RcViewerSelect } from "./rcViewer/registry.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Placement } from "./settings.js";
import { resolvePlacement } from "./sessionViews.js";
import { claudeDir, claudeFile, isDefaultClaudeDir, readActive, readJson, withClaudeDir, type ActiveSession } from "./transcript/locate.js";
import { ranFromQueue } from "./transcript/queue.js";
import type { Mode } from "./tui/layout.js";
import { requestView, runningViewer, type ViewerAction } from "./viewer.js";

const VIEW_NAMES: Record<Mode, string> = { chat: "chat", git: "git changes", plan: "plan", sessions: "sessions", settings: "settings", monitor: "monitor", accounts: "accounts" };

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
  // No windowsHide: explorer applies the hidden start to the window it opens for a folder, which then never shows.
  const child = proc.spawn(command, [file], { stdio: "ignore", detached: true, windowsHide: false });
  child.on?.("error", () => {});
  child.unref();
}

/**
 * Continues a session with `claude --resume` in a new window (Windows
 * Terminal, tmux), in the folder it ran in. The shell stays open after
 * Claude Code exits. Returns what happened, for the help line.
 * The new Claude Code must not inherit the variables of the Claude Code this
 * viewer was opened from (see `independentEnv`). `window` names the Windows
 * Terminal window (`resumeForPairing`); by default it is a new one. `configDir` starts it in another
 * account: under that config folder (`withClaudeDir`). `fresh`: a new session under the id `sessionId` instead.
 */
export function resumeInNewWindow(sessionId: string, dir: string, title: string, window = "new", configDir?: string, fresh = false): string {
  const terminal = detectTerminal();
  if (terminal === "wt") {
    // -w new: without it, wt may add a tab to an open window (its windowingBehavior setting).
    // `cco claude` (`runClaudeIn`) starts claude under the config folder, whether it is an .exe or an npm .cmd
    // shim, and keeps a shell open afterwards. The folder goes as an argument: a pane or tab of a running
    // Windows Terminal does not get the environment of the wt call (a viewer opened from another account's
    // Claude Code ran under the default folder).
    const account = configDir ?? claudeDir();
    const args = ["-w", window, "new-tab", "--title", title, "-d", dir, process.execPath, CLI, "claude", "--config-dir", account, "--", sessionFlag(fresh), sessionId];
    // No windowsHide: wt would apply the hidden start to the new window, which then never shows.
    proc.spawn("wt", args, { stdio: "ignore", detached: true, windowsHide: false, env: withClaudeDir(independentEnv(), account) }).unref();
    return "started in a new Windows Terminal window";
  }
  if (terminal === "tmux") {
    proc.spawn("tmux", ["new-window", "-n", title, "-c", dir, tmuxResume(sessionId, configDir, fresh)], { stdio: "ignore", detached: true }).unref();
    return "started in a new tmux window";
  }
  return `no Windows Terminal or tmux: run ${resumeShellCommand(sessionId, configDir, process.platform, fresh)} in ${dir}`;
}

/** What a session viewer is opened for: a session of this machine (in its folder and config folder), or a remote one. */
export type ViewerTarget = { sessionId: string; cwd: string; configDir?: string } | { remoteId: string };

/** The `cco watch` arguments of a viewer of `target`, in window `window`. */
function viewerArgs(target: ViewerTarget, window?: string): string[] {
  const where = window ? ["--window", window] : [];
  if ("remoteId" in target) return ["watch", "--remote", target.remoteId, "--config-dir", claudeDir(), ...where];
  return ["watch", "--session", target.sessionId, "--cwd", target.cwd, "--config-dir", target.configDir ?? claudeDir(), ...where];
}

/** The command that opens a viewer of `target` by hand, for a terminal cco cannot open windows in. */
export function viewerCommand(target: ViewerTarget, platform: NodeJS.Platform = process.platform): string {
  if ("remoteId" in target) return `cco watch --remote ${target.remoteId}`;
  // cmd and PowerShell take double quotes, POSIX shells single ones; a plain path needs none.
  const quote = (s: string) => (!/[\s"'$&;|()<>`]/.test(s) ? s : platform === "win32" ? `"${s}"` : shellQuote(s));
  const account = target.configDir && !isDefaultClaudeDir(target.configDir) ? ` --config-dir ${quote(target.configDir)}` : "";
  return `cco watch --session ${target.sessionId} --cwd ${quote(target.cwd)}${account}`;
}

/**
 * Opens a viewer of `target` (the chat only, live; a prompt line for a remote session while steer remote is on)
 * in a new window named `window` (`viewerWindow`): any number per session. Returns what happened, or undefined
 * without Windows Terminal or tmux (then `viewerCommand` is the way).
 */
export function openSessionViewer(target: ViewerTarget, title: string, window: string): string | undefined {
  const terminal = detectTerminal();
  const args = [process.execPath, CLI, ...viewerArgs(target, window)];
  // The viewer reads the session; claude's variables must not make it a part of the Claude Code it was opened from.
  const env = independentEnv();
  if (terminal === "wt") {
    // A name of its own makes a new window; no windowsHide, see resumeInNewWindow.
    proc.spawn("wt", ["-w", window, "new-tab", "--title", title, ...args], { stdio: "ignore", detached: true, windowsHide: false, env }).unref();
    return "opened in a new window";
  }
  if (terminal === "tmux") {
    proc.spawn("tmux", ["new-window", "-n", window, args.map(shellQuote).join(" ")], { stdio: "ignore", detached: true, env }).unref();
    return "opened in a new tmux window";
  }
  return undefined;
}

/** The window cco opens the Remote Control Viewer in (`cco rc-viewer`), one per machine. */
export const RC_VIEWER_WINDOW = "cco-rc-viewer";

/**
 * Opens the Remote Control Viewer (`cco rc-viewer`) in a window of its own (`RC_VIEWER_WINDOW`), or brings the one that runs (`running`,
 * its window) to the front. Returns what happened, or undefined without Windows Terminal or tmux (then `cco rc-viewer`
 * by hand is the way).
 */
export function openRcViewer(running?: { pid: number; window?: string }, select?: RcViewerSelect): string | undefined {
  const terminal = detectTerminal();
  if (running) {
    // It selects the session as soon as it reads the request, also where its window cannot be raised.
    if (select) requestRcViewerSelect(select);
    if (running.window && terminal && focusSessionViewer(running.window)) return "brought the Remote Control Viewer to the front";
    return `the Remote Control Viewer runs already (pid ${running.pid}), in a terminal of its own`;
  }
  const chosen = !select ? [] : select.remote ? ["--select-remote", select.id] : ["--select", select.id, ...(select.configDir ? ["--select-dir", select.configDir] : [])];
  const args = [process.execPath, CLI, "rc-viewer", "--config-dir", claudeDir(), "--window", RC_VIEWER_WINDOW, ...chosen];
  // It watches every session; claude's variables must not make it a part of the Claude Code it was opened from.
  const env = independentEnv();
  if (terminal === "wt") {
    // No windowsHide, see resumeInNewWindow.
    proc.spawn("wt", ["-w", RC_VIEWER_WINDOW, "new-tab", "--title", "cco rc-viewer", ...args], { stdio: "ignore", detached: true, windowsHide: false, env }).unref();
    return "opened the Remote Control Viewer in a new window";
  }
  if (terminal === "tmux") {
    proc.spawn("tmux", ["new-window", "-n", RC_VIEWER_WINDOW, args.map(shellQuote).join(" ")], { stdio: "ignore", detached: true, env }).unref();
    return "opened the Remote Control Viewer in a new tmux window";
  }
  return undefined;
}

/** Brings the window of a session viewer (`window`) to the front; false without Windows Terminal or tmux. */
export function focusSessionViewer(window: string): boolean {
  const terminal = detectTerminal();
  if (terminal === "wt") proc.spawn("wt", ["-w", window, "focus-tab", "-t", "0"], { stdio: "ignore", detached: true, windowsHide: false, env: independentEnv() }).unref();
  else if (terminal === "tmux") proc.spawn("tmux", ["select-window", "-t", window], { stdio: "ignore", detached: true, env: independentEnv() }).unref();
  return terminal !== undefined;
}

/**
 * Runs the start script of an account (`script`, its full path) in a new window, in the folder `dir`, with a shell
 * kept open afterwards; for its first start and `/login`. The script sets the config folder itself. Returns what
 * happened, or undefined without Windows Terminal or tmux.
 */
export function scriptInNewWindow(script: string, dir: string, title: string): string | undefined {
  const terminal = detectTerminal();
  const env = independentEnv();
  delete env.CLAUDE_CONFIG_DIR;
  if (terminal === "wt") {
    // cmd /k runs the .cmd and stays; no windowsHide, see resumeInNewWindow.
    proc.spawn("wt", ["-w", "new", "new-tab", "--title", title, "-d", dir, "cmd", "/k", script], { stdio: "ignore", detached: true, windowsHide: false, env }).unref();
    return "started in a new Windows Terminal window";
  }
  if (terminal === "tmux") {
    const shell = process.env.SHELL || "sh";
    proc.spawn("tmux", ["new-window", "-n", title, "-c", dir, `unset ${SESSION_BOUND_VARS.join(" ")} CLAUDE_CONFIG_DIR; ${shellQuote(script)}; exec ${shell}`], { stdio: "ignore", detached: true, env }).unref();
    return "started in a new tmux window";
  }
  return undefined;
}

/**
 * The shell command that continues the session, under the config folder `configDir` if given: POSIX syntax,
 * except on Windows, where it is written for cmd (`set "…" && claude …`).
 */
export function resumeShellCommand(sessionId: string, configDir?: string, platform: NodeJS.Platform = process.platform, fresh = false, home = homedir()): string {
  const claude = `claude ${sessionFlag(fresh)} ${sessionId}`;
  if (!configDir) return claude;
  // A folder in the home folder is named through its variable, as the start scripts do: shorter, and the same on every machine.
  const rel = relative(home, configDir);
  const inHome = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && /^[\w.\\/-]+$/.test(rel);
  if (platform === "win32") {
    if (isDefaultClaudeDir(configDir)) return `set "CLAUDE_CONFIG_DIR=" && ${claude}`;
    return `set "CLAUDE_CONFIG_DIR=${inHome ? `%USERPROFILE%\\${rel}` : configDir}" && ${claude}`;
  }
  if (isDefaultClaudeDir(configDir)) return `env -u CLAUDE_CONFIG_DIR ${claude}`;
  return `CLAUDE_CONFIG_DIR=${inHome ? `"$HOME/${rel}"` : shellQuote(configDir)} ${claude}`;
}

/** How claude takes the session id: one to continue (`--resume`), or the id of a new one (`--session-id`, `fresh`). */
const sessionFlag = (fresh: boolean) => (fresh ? "--session-id" : "--resume");

/** `s` in single quotes for a POSIX shell. */
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The shell command of a tmux window that continues the session and keeps a shell afterwards; under `configDir` if given. */
function tmuxResume(sessionId: string, configDir?: string, fresh = false): string {
  const shell = process.env.SHELL || "sh";
  const id = sessionId.replace(/'/g, "");
  // The window's shell stays in the account it was started for.
  const account = configDir ? (isDefaultClaudeDir(configDir) ? "unset CLAUDE_CONFIG_DIR; " : `export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}; `) : "";
  // tmux takes the environment from its server, which may itself have been started inside Claude Code.
  return `unset ${SESSION_BOUND_VARS.join(" ")}; ${account}claude ${sessionFlag(fresh)} '${id}'; exec ${shell}`;
}

/** The name of the Windows Terminal window a session is continued in for pairing. */
export const pairingWindow = (sessionId: string) => `cco-resume-${sessionId.slice(0, 8)}`;

/**
 * Like `resumeInNewWindow`, for a viewer that then moves next to the new Claude Code: also returns
 * where it runs, for `cco open --target`. In Windows Terminal a window named after the session
 * (`pairingWindow`), in tmux the id of the new pane (`%7`). No target without a supported terminal.
 */
export async function resumeForPairing(sessionId: string, dir: string, title: string): Promise<{ message: string; target?: string }> {
  const terminal = detectTerminal();
  if (terminal === "wt") {
    const window = pairingWindow(sessionId);
    return { message: resumeInNewWindow(sessionId, dir, title, window), target: window };
  }
  if (terminal !== "tmux") return { message: resumeInNewWindow(sessionId, dir, title, "new") };
  const pane = await new Promise<string | undefined>((resolve) =>
    proc.execFile("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-n", title, "-c", dir, tmuxResume(sessionId)], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? undefined : String(stdout).trim() || undefined),
    ),
  );
  return pane ? { message: "started in a new tmux window", target: pane } : { message: "the tmux window could not be opened" };
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
  /** /cco:restart reopens a running viewer (a new one just opens), /cco:update checks for an update and offers it. */
  action?: ViewerAction;
  /**
   * Where Claude Code runs, instead of the calling tab: a Windows Terminal window name or a tmux pane id
   * (`resumeForPairing`). A viewer that paired with a Claude Code it started moves next to it.
   */
  target?: string;
}

/** What `cco open` says it asked a running viewer to do. */
const ACTION_DONE: Record<ViewerAction, string> = {
  restart: "cco is open; it restarts in the same place and view with the version installed now.",
  update: "cco is open; it checks for an update and asks in the settings view whether to install it.",
  account: "cco is open; it asks in the sessions view which account to continue this session in.",
};

/**
 * Opens the viewer next to the current terminal pane (Windows Terminal or
 * tmux): docked right or left, or in a window of its own.
 */
export function openPane(cwd: string, view: Mode | undefined, opts: OpenOptions = {}): string {
  const { claudePid, action } = opts;
  if (!opts.replace && runningViewer(cwd, claudePid) !== undefined) {
    requestView(cwd, view, claudePid, opts.select, action);
    if (action) return ACTION_DONE[action];
    // Without a view (/cco:open) it keeps the one it shows.
    return view ? `cco is already open; switched it to the ${VIEW_NAMES[view]} view.` : "cco is already open.";
  }
  const terminal = detectTerminal();
  const chosen = opts.placement ?? resolvePlacement(cwd, sessionOfProcess(cwd, claudePid)?.session_id);
  // wt finds the window of the calling tab through WT_SESSION. A Claude Code without it (restarted
  // itself, or a session run by the Claude Code daemon) has no tab to dock to: wt would open a new
  // window anyway, hidden by windowsHide. Open the viewer in a window of its own instead.
  const tabless = terminal === "wt" && !process.env.WT_SESSION && !opts.target && chosen !== "window";
  // split-pane splits the tab active now, which after a wait may be another one (the user moved on).
  // wt cannot name the calling tab, so a queued command opens the window of this process instead.
  const away = terminal === "wt" && !tabless && opts.queued === true && chosen !== "window";
  const placement = tabless || away ? "window" : chosen;

  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  // Without a view (/cco:open, /cco:restart with no viewer running), the viewer starts in the session's last one.
  // The config folder (account) goes as an argument: neither a tmux pane nor a Windows Terminal pane gets the
  // environment of the call, so a viewer of another account's Claude Code ran under the default folder.
  const viewer = [process.execPath, CLI, "watch", "--cwd", cwd, "--config-dir", claudeDir(), ...(view ? ["--view", view] : []), "--placement", placement];
  // The viewer cannot ask the terminal whether it has the focus; tell it.
  const unfocused = opts.keepFocus && !(placement === "window" && terminal === "wt");
  if (unfocused) viewer.push("--unfocused");
  if (opts.select) viewer.push("--select", opts.select);
  if (opts.updatedTo) viewer.push("--updated-to", opts.updatedTo);
  // A restart has nothing to restart in a new viewer; an update check is run by it.
  if (action === "update" || action === "account") viewer.push("--action", action);
  // The viewer follows the session of this Claude Code process, not whichever session of the project is newest.
  if (claudePid) viewer.push("--claude-pid", String(claudePid));

  const where = PLACE_NAMES[placement];
  const label = view ? ` ${VIEW_NAMES[view]}` : "";
  if (terminal === "tmux") {
    const cmd = viewer.map(shellQuote).join(" ");
    // -d leaves the current pane active; -b puts the new pane before (left of) it.
    const keep = opts.keepFocus ? ["-d"] : [];
    // Claude Code's own pane, not the one active now (a queued command runs only at the end of the turn).
    const pane = opts.target ?? process.env.TMUX_PANE;
    const args =
      placement === "window"
        ? ["new-window", ...keep, ...(pane ? ["-a", "-t", pane] : []), "-n", "cco", "-c", cwd, cmd]
        : ["split-window", "-h", ...(placement === "left" ? ["-b"] : []), ...keep, ...(pane ? ["-t", pane] : []), "-c", cwd, cmd];
    proc.spawn("tmux", args, { stdio: "ignore", detached: true }).unref();
    return placement === "window" ? `Opened cco${label} in a tmux window.` : `Opened cco${label} in a tmux pane${where}.`;
  }
  if (terminal === "wt") {
    let args: string[];
    if (placement === "window") {
      // A window per Claude Code process: wt creates it under this name, or adds a tab if it still exists.
      args = ["-w", claudePid ? `cco-${claudePid}` : "cco", "new-tab", "--title", "cco", "-d", cwd, ...viewer];
    } else {
      // split-pane only opens to the right; swap-pane moves the new (active) pane to the left.
      args = ["-w", opts.target ?? "0", "split-pane", "-V", "--title", "cco", "-d", cwd, ...viewer];
      if (placement === "left") args.push(";", "swap-pane", "left");
      if (opts.keepFocus) args.push(";", "move-focus", placement === "left" ? "right" : "left");
    }
    // windowsHide asks Windows to start hidden, which Windows Terminal applies to a new window: only for panes.
    proc.spawn("wt", args, { stdio: "ignore", detached: true, windowsHide: placement !== "window" }).unref();
    if (tabless) return `Opened cco${label} in a Windows Terminal window: this Claude Code has no terminal tab to dock to.`;
    if (away) return `Opened cco${label} in a Windows Terminal window: Claude was busy, and the pane would have opened in whichever tab is active now. Press p in it to dock it.`;
    return placement === "window" ? `Opened cco${label} in a Windows Terminal window.` : `Opened cco${label} in a Windows Terminal pane${where}.`;
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
 * After an update (`updatedTo`), the CLI started is the new one. `target` names where the
 * Claude Code runs when that is not the viewer's terminal (see `OpenOptions.target`). `cli` replaces this
 * process's CLI (the release after the switch from a checkout).
 */
export function moveViewer(cwd: string, view: Mode, placement: Placement, claudePid: number | undefined, updatedTo?: string, target?: string, cli = CLI): boolean {
  if (!detectTerminal()) return false;
  const args = [cli, "open", "--cwd", cwd, "--view", view, "--placement", placement, "--after-pid", String(process.pid)];
  if (claudePid) args.push("--claude-pid", String(claudePid));
  if (updatedTo) args.push("--updated-to", updatedTo);
  if (target) args.push("--target", target);
  proc.spawn(process.execPath, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  return true;
}
