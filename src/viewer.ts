import { rmSync } from "node:fs";
import type { Mode } from "./tui/layout.js";
import { controlFile, readJson, restoreFile, viewerFile, writeJson } from "./transcript/locate.js";

export interface ViewerInfo {
  pid: number;
  /** View currently shown, remembered for reopening on the next start. */
  view?: Mode;
}

export interface ControlRequest {
  view: Mode;
  /** Epoch ms; a viewer ignores requests older than its own start. */
  at: number;
}

/** Whether the viewer was open when Claude Code exited, to restore it on the next start. */
export interface RestoreState {
  open: boolean;
  view: Mode;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function registerViewer(cwd: string, view: Mode): void {
  writeJson(viewerFile(cwd), { pid: process.pid, view } satisfies ViewerInfo);
}

/** Records the view the running viewer shows; ignored if another viewer took over. */
export function setViewerView(cwd: string, view: Mode): void {
  if (readJson<ViewerInfo>(viewerFile(cwd))?.pid === process.pid) registerViewer(cwd, view);
}

export function unregisterViewer(cwd: string): void {
  if (readJson<ViewerInfo>(viewerFile(cwd))?.pid === process.pid) rmSync(viewerFile(cwd), { force: true });
}

/** The viewer running for the project, ignoring registrations of dead processes. */
export function runningViewer(cwd: string): ViewerInfo | undefined {
  const info = readJson<ViewerInfo>(viewerFile(cwd));
  return info && isAlive(info.pid) ? info : undefined;
}

export function requestView(cwd: string, view: Mode): void {
  writeJson(controlFile(cwd), { view, at: Date.now() } satisfies ControlRequest);
}

export function readControl(cwd: string): ControlRequest | undefined {
  return readJson<ControlRequest>(controlFile(cwd));
}

export function saveRestore(cwd: string, state: RestoreState): void {
  writeJson(restoreFile(cwd), state);
}

export function readRestore(cwd: string): RestoreState | undefined {
  return readJson<RestoreState>(restoreFile(cwd));
}
