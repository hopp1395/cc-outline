import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Mode } from "./tui/layout.js";
import { requestView, runningViewer } from "./viewer.js";

const VIEW_NAMES: Record<Mode, string> = { chat: "chat", git: "git changes" };

/** Opens the viewer in a split pane next to the current terminal (Windows Terminal or tmux). */
export function openPane(cwd: string, view: Mode): string {
  if (runningViewer(cwd) !== undefined) {
    requestView(cwd, view);
    return `cce is already open; switched it to the ${VIEW_NAMES[view]} view.`;
  }

  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  const viewer = [process.execPath, fileURLToPath(import.meta.url), "watch", "--cwd", cwd, "--view", view];

  if (process.env.TMUX) {
    const cmd = viewer.map((a) => `'${a.replace(/'/g, "'\''")}'`).join(" ");
    spawn("tmux", ["split-window", "-h", "-c", cwd, cmd], { stdio: "ignore", detached: true }).unref();
    return `Opened cce ${VIEW_NAMES[view]} in a tmux pane.`;
  }
  if (process.env.WT_SESSION) {
    spawn(
      "wt",
      ["-w", "0", "split-pane", "-V", "--title", "cce", "-d", cwd, ...viewer],
      { stdio: "ignore", detached: true, windowsHide: true },
    ).unref();
    return `Opened cce ${VIEW_NAMES[view]} in a Windows Terminal pane.`;
  }
  return `No supported terminal detected (Windows Terminal or tmux). Run in another terminal: cce watch --view ${view} --cwd "${cwd}"`;
}
