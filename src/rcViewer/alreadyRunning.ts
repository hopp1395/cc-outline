import type { Terminal } from "../open.js";
import type { RcViewerInfo } from "./registry.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** When `ms` was, for the notice: the time today, else the day and the time. */
function since(ms: number, now: Date): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/**
 * What a second `cco rc-viewer` shows when one runs already (`other`), until a key is pressed. `window`: the one cco opened this
 * one in (`--window`), none when it was started by hand; `terminal`: the one it runs in. Windows Terminal puts both in tabs of
 * the same window, WezTerm and tmux open windows of their own.
 */
export function alreadyRunningNotice(other: RcViewerInfo, window: string | undefined, terminal: Terminal | undefined, now = new Date()): string[] {
  const where = !window || !other.window ? "in another terminal" : terminal === "wt" && other.window === window ? "in another tab of this window" : "in another window";
  return [
    `The Remote Control Viewer runs already (pid ${other.pid}, since ${since(other.started, now)}), ${where}.`,
    "One runs per machine: it shows the sessions of every project and account.",
    "",
    window ? "Press any key to close this tab." : "Press any key to quit.",
  ];
}

/** Waits for one key on a terminal's stdin; at once where stdin is no terminal (a pipe, a script). */
export function waitForKey(stdin: NodeJS.ReadStream = process.stdin): Promise<void> {
  if (!stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}
