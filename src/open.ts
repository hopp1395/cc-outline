import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Opens the viewer in a split pane next to the current terminal (Windows Terminal or tmux). */
export function openPane(cwd: string): string {
  // Invoke node directly: Windows Terminal cannot launch npm's .cmd shims by bare name.
  const viewer = [process.execPath, fileURLToPath(import.meta.url), "watch", "--cwd", cwd];

  if (process.env.TMUX) {
    const cmd = viewer.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    spawn("tmux", ["split-window", "-h", "-c", cwd, cmd], { stdio: "ignore", detached: true }).unref();
    return "Opened ccmd in a tmux pane.";
  }
  if (process.env.WT_SESSION) {
    spawn(
      "wt",
      ["-w", "0", "split-pane", "-V", "--title", "ccmd", "-d", cwd, ...viewer],
      { stdio: "ignore", detached: true, windowsHide: true },
    ).unref();
    return "Opened ccmd in a Windows Terminal pane.";
  }
  return `No supported terminal detected (Windows Terminal or tmux). Run in another terminal: ccmd watch --cwd "${cwd}"`;
}
