import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsHome } from "../addAccount.js";
import { readJson, writeJson } from "../transcript/locate.js";
import { isAlive } from "../viewer.js";

/** The Remote Control Viewer that runs (`cco rc-viewer`): one per machine, whatever account it was started from. */
export interface RcViewerInfo {
  pid: number;
  /** The config folder (account) it was started from. */
  configDir?: string;
  /** The Windows Terminal or tmux window it runs in, if cco opened it. */
  window?: string;
  /** When it started (ms). */
  started: number;
}

/** Where the Remote Control Viewer registers: below the default `~/.claude`, so a start from any account finds it. */
export const rcViewerFile = () => join(accountsHome.get(), ".claude", "cco", "rc-viewer.json");

/** The Remote Control Viewer that runs, if any; a registration of a process that is gone counts as none. */
export function runningRcViewer(): RcViewerInfo | undefined {
  const info = readJson<RcViewerInfo>(rcViewerFile());
  return info && typeof info === "object" && typeof info.pid === "number" && isAlive(info.pid) ? info : undefined;
}

/** Records this process as the Remote Control Viewer until it exits. */
export function registerRcViewer(info: Omit<RcViewerInfo, "pid" | "started">): void {
  const file = rcViewerFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { ...info, pid: process.pid, started: Date.now() } satisfies RcViewerInfo);
  process.on("exit", () => {
    // Only its own: a Remote Control Viewer started after it (this one hung) may have taken the file.
    if (readJson<RcViewerInfo>(file)?.pid === process.pid) rmSync(file, { force: true });
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
