import { favoritesFile, readJson, writeJson } from "./transcript/locate.js";

/** Marked turn ids by session id, stored per project. */
type Favorites = Record<string, string[]>;

function readAll(cwd: string): Favorites {
  const stored = readJson<Favorites>(favoritesFile(cwd));
  return stored && typeof stored === "object" ? stored : {};
}

/** Ids of the marked turns of one session. */
export function readFavorites(cwd: string, sessionId: string): string[] {
  const ids = readAll(cwd)[sessionId];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

/** Marks or unmarks a turn and returns the session's marked ids. Re-reads first so other viewers' marks survive. */
export function toggleFavorite(cwd: string, sessionId: string, turnId: string): string[] {
  const all = readAll(cwd);
  const ids = readFavorites(cwd, sessionId);
  const next = ids.includes(turnId) ? ids.filter((id) => id !== turnId) : [...ids, turnId];
  if (next.length > 0) all[sessionId] = next;
  else delete all[sessionId];
  writeJson(favoritesFile(cwd), all);
  return next;
}
