import { join } from "node:path";
import { claudeDir, favoritesFile, readJson, writeJson } from "./transcript/locate.js";

/**
 * What can be marked, per list: chat turns (prompt uuids), changed files
 * (paths), plans (tool call ids), sessions (session ids), Monitor days ("2026-09-27")
 * and settings (setting keys, "reset:<id>"). Turn ids survive `--continue`/`/resume`,
 * which copy the turns into a new session, so marks are kept per project; the
 * settings are global, and so are their marks.
 */
export type FavoriteKind = "turns" | "files" | "plans" | "sessions" | "days" | "settings";

type Stored = Partial<Record<FavoriteKind, string[]>>;

const KINDS: FavoriteKind[] = ["turns", "files", "plans", "sessions", "days", "settings"];

/** The marks of the settings, next to settings.json. */
export function globalFavoritesFile(): string {
  return join(claudeDir(), "cco", "favorites.json");
}

const fileFor = (cwd: string, kind: FavoriteKind) => (kind === "settings" ? globalFavoritesFile() : favoritesFile(cwd));

/** Writes the lists that belong in `kind`'s file: the settings' alone, or all the others. */
function writeAll(file: string, kind: FavoriteKind, all: Record<FavoriteKind, string[]>): void {
  const kinds = KINDS.filter((k) => (k === "settings") === (kind === "settings"));
  writeJson(file, Object.fromEntries(kinds.map((k) => [k, all[k]])) satisfies Stored);
}

const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);

function readAll(file: string): Record<FavoriteKind, string[]> {
  const stored = readJson<unknown>(file);
  const all: Record<FavoriteKind, string[]> = { turns: [], files: [], plans: [], sessions: [], days: [], settings: [] };
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
  return readAll(fileFor(cwd, kind))[kind];
}

/** Marks or unmarks an entry and returns the list's marked ids. Re-reads first so other viewers' marks survive. */
export function toggleFavorite(cwd: string, kind: FavoriteKind, id: string): string[] {
  const file = fileFor(cwd, kind);
  const all = readAll(file);
  const ids = all[kind];
  all[kind] = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  writeAll(file, kind, all);
  return all[kind];
}

/** Removes all marks of one list, e.g. of the settings when they are reset. */
export function clearFavorites(cwd: string, kind: FavoriteKind): string[] {
  const file = fileFor(cwd, kind);
  const all = readAll(file);
  if (all[kind].length === 0) return [];
  all[kind] = [];
  writeAll(file, kind, all);
  return [];
}

/** Removes a mark, e.g. of a session deleted for good. */
export function removeFavorite(cwd: string, kind: FavoriteKind, id: string): void {
  const file = fileFor(cwd, kind);
  const all = readAll(file);
  if (!all[kind].includes(id)) return;
  all[kind] = all[kind].filter((x) => x !== id);
  writeAll(file, kind, all);
}

/** Index of the next (dir 1) or previous (dir -1) marked entry after `from`, if any. */
export function nextMarked(ids: string[], marks: string[], from: number, dir: 1 | -1): number | undefined {
  for (let i = from + dir; i >= 0 && i < ids.length; i += dir) if (marks.includes(ids[i])) return i;
  return undefined;
}
