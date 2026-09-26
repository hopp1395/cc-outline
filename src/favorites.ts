import { favoritesFile, readJson, writeJson } from "./transcript/locate.js";

/**
 * What can be marked, per list: chat turns (prompt uuids), changed files
 * (paths) and plans (tool call ids). Turn ids survive `--continue`/`/resume`,
 * which copy the turns into a new session, so marks are kept per project.
 */
export type FavoriteKind = "turns" | "files" | "plans";

type Stored = Partial<Record<FavoriteKind, string[]>>;

const KINDS: FavoriteKind[] = ["turns", "files", "plans"];

const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);

function readAll(cwd: string): Record<FavoriteKind, string[]> {
  const stored = readJson<unknown>(favoritesFile(cwd));
  const all: Record<FavoriteKind, string[]> = { turns: [], files: [], plans: [] };
  if (!stored || typeof stored !== "object") return all;
  const record = stored as Record<string, unknown>;
  if (KINDS.some((kind) => kind in record)) {
    for (const kind of KINDS) all[kind] = [...new Set(strings(record[kind]))];
  } else {
    // The first format kept one list of turn ids per session id.
    all.turns = [...new Set(Object.values(record).flatMap(strings))];
  }
  return all;
}

/** Marked ids of one list. */
export function readFavorites(cwd: string, kind: FavoriteKind): string[] {
  return readAll(cwd)[kind];
}

/** Marks or unmarks an entry and returns the list's marked ids. Re-reads first so other viewers' marks survive. */
export function toggleFavorite(cwd: string, kind: FavoriteKind, id: string): string[] {
  const all = readAll(cwd);
  const ids = all[kind];
  all[kind] = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  writeJson(favoritesFile(cwd), all satisfies Stored);
  return all[kind];
}

/** Index of the next (dir 1) or previous (dir -1) marked entry after `from`, if any. */
export function nextMarked(ids: string[], marks: string[], from: number, dir: 1 | -1): number | undefined {
  for (let i = from + dir; i >= 0 && i < ids.length; i += dir) if (marks.includes(ids[i])) return i;
  return undefined;
}
