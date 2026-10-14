import { rmSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, readJson, writeJson } from "../transcript/locate.js";
import { isAlive } from "../viewer.js";

/** One remote viewer per session: its registration names the process, and the window it runs in. */
export interface RemoteViewerInfo {
  pid: number;
  /** The Windows Terminal window or tmux window it was opened in (`remoteWindow`). */
  window: string;
}

/** The file of the remote viewer of session `id`, in cco's folder: remote sessions belong to no project here. */
export const remoteViewerFile = (id: string) => join(claudeDir(), "cco", `remote-${id.replace(/[^A-Za-z0-9_-]/g, "-")}.viewer.json`);

/** The name of the window a remote viewer runs in, the same each time, so opening it again finds it. */
export const remoteWindow = (id: string) => `cco-remote-${id.replace(/[^A-Za-z0-9_-]/g, "-").slice(-12)}`;

/** Records this process as the viewer of remote session `id`, until it exits. */
export function registerRemoteViewer(id: string): void {
  writeJson(remoteViewerFile(id), { pid: process.pid, window: remoteWindow(id) } satisfies RemoteViewerInfo);
  process.on("exit", () => {
    // Only its own: a viewer opened after it may have taken the file over.
    if (readJson<RemoteViewerInfo>(remoteViewerFile(id))?.pid === process.pid) rmSync(remoteViewerFile(id), { force: true });
  });
}

/** The running viewer of remote session `id`, if one runs. */
export function runningRemoteViewer(id: string): RemoteViewerInfo | undefined {
  const info = readJson<RemoteViewerInfo>(remoteViewerFile(id));
  return info && typeof info.pid === "number" && isAlive(info.pid) ? info : undefined;
}
