import { rmSync } from "node:fs";
import type { Mode } from "./tui/layout.js";
import { claudeFile, controlFile, projectStateFiles, readJson, restoreFile, viewerFile, writeJson, type ActiveSession } from "./transcript/locate.js";

export interface ViewerInfo {
  pid: number;
  /** View currently shown, remembered for reopening on the next start. */
  view?: Mode;
}

/** What a running viewer is asked to do besides showing a view: reopen itself (/cco:restart), or check for an update and offer it (/cco:update). */
export const VIEWER_ACTIONS = ["restart", "update"] as const;
export type ViewerAction = (typeof VIEWER_ACTIONS)[number];

export interface ControlRequest {
  /** None: stay in the view shown (/cco:restart). */
  view?: Mode;
  /** An entry to select in the view (`releases` in Settings). */
  select?: string;
  action?: ViewerAction;
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

/** The registration of this process's viewer, removed on exit; pairing moves it. */
let registered: { cwd: string; claudePid?: number } | undefined;

export function registerViewer(cwd: string, view: Mode, claudePid?: number): void {
  registered = { cwd, claudePid };
  writeJson(viewerFile(cwd, claudePid), { pid: process.pid, view } satisfies ViewerInfo);
}

/** Removes the registration this process made last (on exit). */
export function unregisterCurrentViewer(): void {
  if (registered) unregisterViewer(registered.cwd, registered.claudePid);
}

/** A Claude Code process to pair a viewer with, and the session it runs. */
export interface PairTarget {
  cwd: string;
  claudePid: number;
  sessionId: string;
  transcript: string;
}

/**
 * Pairs this viewer, started without a Claude Code process (cco watch by hand), with `target`:
 * its registration moves there, so /cco:… of that process finds it. False if a viewer runs for it already.
 * The process's session file is written if its hooks have not (yet): the viewer follows it.
 */
export function pairViewer(from: { cwd: string; claudePid?: number }, target: PairTarget): boolean {
  if (runningViewer(target.cwd, target.claudePid)) return false;
  const own = claudeFile(target.cwd, target.claudePid);
  if (!readJson<ActiveSession>(own))
    writeJson(own, { session_id: target.sessionId, transcript_path: target.transcript, cwd: target.cwd, updated: new Date().toISOString() } satisfies ActiveSession);
  unregisterViewer(from.cwd, from.claudePid);
  registerViewer(target.cwd, "chat", target.claudePid);
  return true;
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

export function requestView(cwd: string, view: Mode | undefined, claudePid?: number, select?: string, action?: ViewerAction): void {
  writeJson(controlFile(cwd, claudePid), { view, select, action, at: Date.now() } satisfies ControlRequest);
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
