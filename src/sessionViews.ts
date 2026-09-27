import { readJson, sessionViewsFile, writeJson } from "./transcript/locate.js";
import type { Mode } from "./tui/layout.js";

const MODES: readonly Mode[] = ["chat", "git", "plan", "sessions", "settings"];

/** Sessions kept per project; the ones shown longest ago are dropped. */
export const MAX_SESSION_VIEWS = 500;

function read(cwd: string): Record<string, Mode> {
  const stored = readJson<Record<string, unknown>>(sessionViewsFile(cwd));
  const views: Record<string, Mode> = {};
  for (const [id, view] of Object.entries(stored ?? {})) if (MODES.includes(view as Mode)) views[id] = view as Mode;
  return views;
}

/** The view `sessionId` was shown in last, if it was shown at all. */
export function readSessionView(cwd: string, sessionId: string | undefined): Mode | undefined {
  return sessionId ? read(cwd)[sessionId] : undefined;
}

/** Records the view `sessionId` is shown in, in `<slug>.views.json`. */
export function saveSessionView(cwd: string, sessionId: string, view: Mode): void {
  const views = read(cwd);
  if (views[sessionId] === view && Object.keys(views).at(-1) === sessionId) return;
  // Moved to the end, so the least recently shown sessions are dropped first.
  delete views[sessionId];
  views[sessionId] = view;
  const ids = Object.keys(views);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSION_VIEWS))) delete views[old];
  writeJson(sessionViewsFile(cwd), views);
}
