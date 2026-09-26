import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Mode } from "./tui/layout.js";
import { requestView, runningViewer } from "./viewer.js";

const VIEW_NAMES: Record<Mode, string> = { chat: "chat", git: "git changes" };

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
 * Opens the viewer in a split pane next to the current terminal (Windows
 * Terminal or tmux). With `keepFocus` the cursor stays in the Claude Code pane.
 */
export function openPane(cwd: string, view: Mode, opts: { keepFocus?: boolean } = {}): string {
  if (runningViewer(cwd) !== undefined) {
    requestView(cwd, view);
    return `cco is already open; switched it to the ${VIEW_NAMES[view]} view.`;
  }

  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  const viewer = [process.execPath, fileURLToPath(import.meta.url), "watch", "--cwd", cwd, "--view", view];
  // The viewer cannot ask the terminal whether it has the focus; tell it.
  if (opts.keepFocus) viewer.push("--unfocused");

  const terminal = detectTerminal();
  if (terminal === "tmux") {
    const cmd = viewer.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    // -d leaves the current pane active.
    const args = ["split-window", "-h", ...(opts.keepFocus ? ["-d"] : []), "-c", cwd, cmd];
    spawn("tmux", args, { stdio: "ignore", detached: true }).unref();
    return `Opened cco ${VIEW_NAMES[view]} in a tmux pane.`;
  }
  if (terminal === "wt") {
    // The new pane opens to the right; moving focus left returns to Claude Code.
    const args = ["-w", "0", "split-pane", "-V", "--title", "cco", "-d", cwd, ...viewer];
    if (opts.keepFocus) args.push(";", "move-focus", "left");
    spawn("wt", args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
    return `Opened cco ${VIEW_NAMES[view]} in a Windows Terminal pane.`;
  }
  return `No supported terminal detected (Windows Terminal or tmux). Run in another terminal: cco watch --view ${view} --cwd "${cwd}"`;
}
