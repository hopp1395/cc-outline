import { linkSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsHome } from "../addAccount.js";
import { TIMING } from "../timing.js";
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

/**
 * Records this process as the Remote Control Viewer until it exits, unless another one runs: then that one, and nothing is
 * written. The file is made in one step that fails where it exists (a link to a complete copy), so of two that start at the
 * same moment only one gets it; a registration of one that is gone is removed and the claim tried again.
 */
export function claimRcViewer(info: Omit<RcViewerInfo, "pid" | "started">): RcViewerInfo | undefined {
  const file = rcViewerFile();
  mkdirSync(dirname(file), { recursive: true });
  const own: RcViewerInfo = { ...info, pid: process.pid, started: Date.now() };
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    created = createOnly(file, JSON.stringify(own, null, 2));
    if (created) break;
    const other = runningRcViewer();
    if (other && other.pid !== process.pid) return other;
    rmSync(file, { force: true });
  }
  // Removed three times and still taken by none that runs: it is written over, as before the claim.
  if (!created) writeJson(file, own);
  // It started: the next start finds it registered, no longer starting.
  rmSync(rcViewerStartFile(), { force: true });
  const owned = () => readJson<RcViewerInfo>(file)?.pid === process.pid;
  const beat = setInterval(() => {
    // Stops once another took the file or it is gone.
    if (!owned()) return clearInterval(beat);
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
    if (owned()) rmSync(file, { force: true });
  });
  return undefined;
}

/**
 * Creates `file` with `content` unless it exists; false if it does. A hard link of a complete copy: a reader never sees
 * the file half written, which would look like a registration of none. Where the file system has no links, `wx`.
 */
function createOnly(file: string, content: string): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content);
    linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    try {
      writeFileSync(file, content, { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Where a start of the Remote Control Viewer is recorded until it registered (`TIMING.rcViewerStart` at most): a second
 * start in that time (a double click, /cco:rc-viewer of another session) opens no second tab.
 */
export const rcViewerStartFile = () => join(accountsHome.get(), ".claude", "cco", "rc-viewer-starting.json");

/** Records that a Remote Control Viewer is being started now. */
export function markRcViewerStarting(): void {
  const file = rcViewerStartFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { at: Date.now(), by: process.pid });
}

/** Forgets the start recorded by `markRcViewerStarting` (it could not be opened). */
export function clearRcViewerStarting(): void {
  rmSync(rcViewerStartFile(), { force: true });
}

/** When a Remote Control Viewer was started that has not registered yet, if within `TIMING.rcViewerStart`. */
export function rcViewerStarting(now = Date.now()): number | undefined {
  const at = readJson<{ at?: unknown }>(rcViewerStartFile())?.at;
  return typeof at === "number" && now - at >= 0 && now - at < TIMING.rcViewerStart ? at : undefined;
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
