import { mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsHome } from "../addAccount.js";
import { readJson, writeJson } from "../transcript/locate.js";
import { isAlive } from "../viewer.js";

/** The Remote Control Viewer that runs (`cco rc-viewer`): one per machine, whatever account it was started from. */
export interface RcViewerInfo {
  pid: number;
  /** The config folder (account) it was started from. */
  configDir?: string;
  /** The Windows Terminal, WezTerm or tmux window it runs in, if cco opened it. */
  window?: string;
  /** When it started (ms). */
  started: number;
}

/** Where the Remote Control Viewer registers: below the default `~/.claude`, so a start from any account finds it. */
export const rcViewerFile = () => join(accountsHome.get(), ".claude", "cco", "rc-viewer.json");

/** How often the running Remote Control Viewer touches its registration. */
const BEAT = 10_000;
/** A registration not touched for this long is a viewer that died without its exit handler (killed, shut down). */
const STALE = 45_000;

/**
 * The Remote Control Viewer that runs, if any; a registration of a process that is gone counts as none. Its pid alone
 * does not tell: Windows gave the pid of one that was killed to another program, and the next start was refused.
 */
export function runningRcViewer(): RcViewerInfo | undefined {
  const file = rcViewerFile();
  const info = readJson<RcViewerInfo>(file);
  if (!info || typeof info !== "object" || typeof info.pid !== "number" || !isAlive(info.pid)) return undefined;
  if (info.pid === process.pid) return info;
  try {
    return Date.now() - statSync(file).mtimeMs < STALE ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Records this process as the Remote Control Viewer until it exits. */
export function registerRcViewer(info: Omit<RcViewerInfo, "pid" | "started">): void {
  const file = rcViewerFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { ...info, pid: process.pid, started: Date.now() } satisfies RcViewerInfo);
  const own = () => readJson<RcViewerInfo>(file)?.pid === process.pid;
  const beat = setInterval(() => {
    // Stops once another took the file or it is gone.
    if (!own()) return clearInterval(beat);
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      clearInterval(beat);
    }
  }, BEAT);
  beat.unref();
  process.on("exit", () => {
    // Only its own: a Remote Control Viewer started after it (this one hung) may have taken the file.
    if (own()) rmSync(file, { force: true });
  });
}

/** A session the Remote Control Viewer is asked to select: one of this machine's (its id in config folder `configDir`) or a remote one. */
export interface RcViewerSelect {
  id: string;
  /** The config folder (account) of a session of this machine; none for a remote one. */
  configDir?: string;
  remote?: boolean;
}

/** Where the running Remote Control Viewer is asked to select a session (Sessions: Watch it in the Remote Control Viewer, /cco:rc-viewer). */
export const rcViewerControlFile = () => join(accountsHome.get(), ".claude", "cco", "rc-viewer-request.json");

/** Asks the running Remote Control Viewer to select `select`. */
export function requestRcViewerSelect(select: RcViewerSelect): void {
  const file = rcViewerControlFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { ...select, at: Date.now() });
}

/** The latest request to the Remote Control Viewer, if it is a valid one. */
export function readRcViewerRequest(): (RcViewerSelect & { at: number }) | undefined {
  const request = readJson<RcViewerSelect & { at: number }>(rcViewerControlFile());
  return request && typeof request === "object" && typeof request.id === "string" && typeof request.at === "number" ? request : undefined;
}
