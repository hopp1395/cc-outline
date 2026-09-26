import { rmSync } from "node:fs";
import type { Mode } from "./tui/layout.js";
import { controlFile, projectStateFiles, readJson, restoreFile, viewerFile, writeJson } from "./transcript/locate.js";

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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function registerViewer(cwd: string, view: Mode, claudePid?: number): void {
  writeJson(viewerFile(cwd, claudePid), { pid: process.pid, view } satisfies ViewerInfo);
}

/** Records the view the running viewer shows; ignored if another viewer took over. */
export function setViewerView(cwd: string, view: Mode, claudePid?: number): void {
  if (readJson<ViewerInfo>(viewerFile(cwd, claudePid))?.pid === process.pid) registerViewer(cwd, view, claudePid);
}

export function unregisterViewer(cwd: string, claudePid?: number): void {
  const file = viewerFile(cwd, claudePid);
  if (readJson<ViewerInfo>(file)?.pid === process.pid) rmSync(file, { force: true });
}

/**
 * The viewer running for the Claude Code process `claudePid` (or, without it,
 * for the project), ignoring registrations of dead processes.
 */
export function runningViewer(cwd: string, claudePid?: number): ViewerInfo | undefined {
  const info = readJson<ViewerInfo>(viewerFile(cwd, claudePid));
  return info && isAlive(info.pid) ? info : undefined;
}

/** Whether any viewer runs for the project, whichever Claude Code process it belongs to. */
export function anyRunningViewer(cwd: string): boolean {
  return [viewerFile(cwd), ...projectStateFiles(cwd, ".viewer-")].some((file) => {
    const info = readJson<ViewerInfo>(file);
    return info !== undefined && isAlive(info.pid);
  });
}

export function requestView(cwd: string, view: Mode, claudePid?: number): void {
  writeJson(controlFile(cwd, claudePid), { view, at: Date.now() } satisfies ControlRequest);
}

export function readControl(cwd: string, claudePid?: number): ControlRequest | undefined {
  return readJson<ControlRequest>(controlFile(cwd, claudePid));
}

export function saveRestore(cwd: string, state: RestoreState): void {
  writeJson(restoreFile(cwd), state);
}

export function readRestore(cwd: string): RestoreState | undefined {
  return readJson<RestoreState>(restoreFile(cwd));
}
