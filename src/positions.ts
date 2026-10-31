import { positionsFile, readJson, writeJson } from "./transcript/locate.js";

/** The lists whose positions are kept, one per view. */
export type PositionList = "chat" | "git" | "plan" | "sessions" | "settings" | "monitor" | "accounts" | "todo";

/** Which entry of a list was selected, and whether it followed the newest one. */
export interface Selection {
  selected?: string;
  follow?: boolean;
  /** The selected entry's copy in the Pinned group was selected, not its row in the list below; only without follow. */
  pinned?: boolean;
}

/** Where a list was left: the selected entry, whether it followed the newest one, and each entry's scroll position. */
export interface ListPositions extends Selection {
  /** Scroll position per entry key, e.g. a turn id, a file path or "path#file" for its whole-file view. */
  scroll: Record<string, number>;
  /**
   * The selection per session id, for a list of one session's entries (the chat): several viewers of the project
   * (the project's, session viewers) show different sessions. The selection above stays for files written before.
   */
  sessions?: Record<string, Selection>;
}

type Stored = Partial<Record<PositionList, ListPositions>>;

/** Entries kept per list; the ones used longest ago are dropped. */
export const MAX_POSITIONS = 500;

function sanitizeSelection(value: unknown): Selection {
  const v = (value && typeof value === "object" ? value : {}) as Selection;
  return {
    selected: typeof v.selected === "string" ? v.selected : undefined,
    follow: typeof v.follow === "boolean" ? v.follow : undefined,
    pinned: v.pinned === true ? true : undefined,
  };
}

function sanitize(value: unknown): ListPositions {
  const v = (value && typeof value === "object" ? value : {}) as Partial<ListPositions>;
  const scroll: Record<string, number> = {};
  if (v.scroll && typeof v.scroll === "object") {
    for (const [key, n] of Object.entries(v.scroll)) if (typeof n === "number" && n >= 0) scroll[key] = n;
  }
  let sessions: Record<string, Selection> | undefined;
  if (v.sessions && typeof v.sessions === "object") {
    sessions = {};
    for (const [id, sel] of Object.entries(v.sessions)) sessions[id] = sanitizeSelection(sel);
  }
  return { ...sanitizeSelection(v), scroll, ...(sessions ? { sessions } : {}) };
}

/** Positions of one list of the project; empty when nothing was stored yet. */
export function readPositions(cwd: string, list: PositionList): ListPositions {
  return sanitize(readJson<Stored>(positionsFile(cwd))?.[list]);
}

/** While set, positions are not written: the views save theirs when they unmount, which a reset must not undo. */
let writesSuspended = false;

export function suspendPositionWrites(suspended: boolean): void {
  writesSuspended = suspended;
}

/** Stores the positions of one list, re-reading first so the other lists (and other viewers) keep theirs. */
export function savePositions(cwd: string, list: PositionList, positions: ListPositions): void {
  if (writesSuspended) return;
  const stored = readJson<Stored>(positionsFile(cwd)) ?? {};
  writeJson(positionsFile(cwd), { ...stored, [list]: positions } satisfies Stored);
}

/**
 * Changes the stored positions of one list through `change`, applied to what is stored now: other viewers of the
 * project write the same file, and only what this one changed may replace theirs.
 */
export function updatePositions(cwd: string, list: PositionList, change: (stored: ListPositions) => void): void {
  if (writesSuspended) return;
  const stored = readJson<Stored>(positionsFile(cwd)) ?? {};
  const positions = sanitize(stored[list]);
  change(positions);
  writeJson(positionsFile(cwd), { ...stored, [list]: positions } satisfies Stored);
}

/** Records the selection of session `id`, moving it to the end so the sessions shown longest ago are dropped first. */
export function rememberSelection(positions: ListPositions, id: string, selection: Selection): void {
  const sessions = (positions.sessions ??= {});
  delete sessions[id];
  sessions[id] = selection;
  const ids = Object.keys(sessions);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_POSITIONS))) delete sessions[old];
}

/** Drops the scroll positions of `keys` from one list, e.g. of a session moved to another project. */
export function forgetScroll(cwd: string, list: PositionList, keys: string[]): void {
  const positions = readPositions(cwd, list);
  const present = keys.filter((k) => k in positions.scroll);
  if (present.length === 0) return;
  for (const k of present) delete positions.scroll[k];
  savePositions(cwd, list, positions);
}

/** Records `n` for `key`, moving it to the end so the least recently used entries are dropped first. */
export function rememberScroll(positions: ListPositions, key: string, n: number): void {
  delete positions.scroll[key];
  positions.scroll[key] = n;
  const keys = Object.keys(positions.scroll);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete positions.scroll[old];
}
