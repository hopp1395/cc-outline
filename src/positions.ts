import { positionsFile, readJson, writeJson } from "./transcript/locate.js";

/** The lists whose positions are kept, one per view. */
export type PositionList = "chat" | "git" | "plan" | "sessions" | "settings" | "monitor";

/** Where a list was left: the selected entry, whether it followed the newest one, and each entry's scroll position. */
export interface ListPositions {
  selected?: string;
  follow?: boolean;
  /** Scroll position per entry key, e.g. a turn id, a file path or "path#file" for its whole-file view. */
  scroll: Record<string, number>;
}

type Stored = Partial<Record<PositionList, ListPositions>>;

/** Entries kept per list; the ones used longest ago are dropped. */
export const MAX_POSITIONS = 500;

function sanitize(value: unknown): ListPositions {
  const v = (value && typeof value === "object" ? value : {}) as Partial<ListPositions>;
  const scroll: Record<string, number> = {};
  if (v.scroll && typeof v.scroll === "object") {
    for (const [key, n] of Object.entries(v.scroll)) if (typeof n === "number" && n >= 0) scroll[key] = n;
  }
  return {
    selected: typeof v.selected === "string" ? v.selected : undefined,
    follow: typeof v.follow === "boolean" ? v.follow : undefined,
    scroll,
  };
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

/** Records `n` for `key`, moving it to the end so the least recently used entries are dropped first. */
export function rememberScroll(positions: ListPositions, key: string, n: number): void {
  delete positions.scroll[key];
  positions.scroll[key] = n;
  const keys = Object.keys(positions.scroll);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete positions.scroll[old];
}
