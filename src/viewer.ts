import { rmSync } from "node:fs";
import type { Mode } from "./tui/layout.js";
import { controlFile, readJson, viewerFile, writeJson } from "./transcript/locate.js";

interface ViewerInfo {
  pid: number;
}

export interface ControlRequest {
  view: Mode;
  /** Epoch ms; a viewer ignores requests older than its own start. */
  at: number;
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

export function registerViewer(cwd: string): void {
  writeJson(viewerFile(cwd), { pid: process.pid } satisfies ViewerInfo);
}

export function unregisterViewer(cwd: string): void {
  if (readJson<ViewerInfo>(viewerFile(cwd))?.pid === process.pid) rmSync(viewerFile(cwd), { force: true });
}

/** Pid of the viewer running for the project, ignoring registrations of dead processes. */
export function runningViewer(cwd: string): number | undefined {
  const pid = readJson<ViewerInfo>(viewerFile(cwd))?.pid;
  return pid !== undefined && isAlive(pid) ? pid : undefined;
}

export function requestView(cwd: string, view: Mode): void {
  writeJson(controlFile(cwd), { view, at: Date.now() } satisfies ControlRequest);
}

export function readControl(cwd: string): ControlRequest | undefined {
  return readJson<ControlRequest>(controlFile(cwd));
}
