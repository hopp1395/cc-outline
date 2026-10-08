import { PLACEMENT_VALUES, readSettings, type Placement } from "./settings.js";
import { readJson, sessionViewsFile, writeJson } from "./transcript/locate.js";
import type { Mode } from "./tui/layout.js";

const MODES: readonly Mode[] = ["chat", "git", "plan", "sessions", "settings", "monitor"];

/** Sessions kept per project; the ones shown longest ago are dropped. */
export const MAX_SESSION_VIEWS = 500;

/** What is remembered of a session: the view it was shown in last and the placement chosen for it with p. */
interface SessionEntry {
  view?: Mode;
  placement?: Placement;
}

function read(cwd: string): Record<string, SessionEntry> {
  const stored = readJson<Record<string, unknown>>(sessionViewsFile(cwd));
  const entries: Record<string, SessionEntry> = {};
  for (const [id, value] of Object.entries(stored ?? {})) {
    // The first format stored only the view, as a string.
    const raw = (typeof value === "string" ? { view: value } : value) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") continue;
    const entry: SessionEntry = {};
    if (MODES.includes(raw.view as Mode)) entry.view = raw.view as Mode;
    if (PLACEMENT_VALUES.includes(raw.placement as Placement)) entry.placement = raw.placement as Placement;
    if (entry.view || entry.placement) entries[id] = entry;
  }
  return entries;
}

/** Merges `changes` into the session's entry and moves it to the end, so the least recently shown sessions are dropped first. */
function update(cwd: string, sessionId: string, changes: SessionEntry): void {
  const entries = read(cwd);
  const current = entries[sessionId];
  const next = { ...current, ...changes };
  if (current?.view === next.view && current?.placement === next.placement && Object.keys(entries).at(-1) === sessionId) return;
  delete entries[sessionId];
  entries[sessionId] = next;
  const ids = Object.keys(entries);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSION_VIEWS))) delete entries[old];
  writeJson(sessionViewsFile(cwd), entries);
}

/** The view `sessionId` was shown in last, if it was shown at all. */
export function readSessionView(cwd: string, sessionId: string | undefined): Mode | undefined {
  return sessionId ? read(cwd)[sessionId]?.view : undefined;
}

/** Records the view `sessionId` is shown in, in `<slug>.views.json`. */
export function saveSessionView(cwd: string, sessionId: string, view: Mode): void {
  update(cwd, sessionId, { view });
}

/** The placement chosen for `sessionId` with p in the viewer, if any. */
export function readSessionPlacement(cwd: string, sessionId: string | undefined): Placement | undefined {
  return sessionId ? read(cwd)[sessionId]?.placement : undefined;
}

/** Records the placement chosen for `sessionId`. */
export function saveSessionPlacement(cwd: string, sessionId: string, placement: Placement): void {
  update(cwd, sessionId, { placement });
}

/** Forgets what was remembered of `sessionId`, e.g. when it moved to another project. */
export function forgetSessionView(cwd: string, sessionId: string): void {
  const entries = read(cwd);
  if (!(sessionId in entries)) return;
  delete entries[sessionId];
  writeJson(sessionViewsFile(cwd), entries);
}

/** Where the viewer opens for `sessionId`: the placement chosen for it, else the setting. */
export function resolvePlacement(cwd: string, sessionId: string | undefined): Placement {
  return readSessionPlacement(cwd, sessionId) ?? readSettings().placement;
}
