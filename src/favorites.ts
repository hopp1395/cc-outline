import { favoritesFile, readJson, writeJson } from "./transcript/locate.js";

/**
 * Marked turn ids of a project. Turn ids are the prompts' uuids, which Claude
 * Code keeps when a session is continued or resumed under a new session id,
 * so marks are stored per project rather than per session.
 */
interface Stored {
  turns: string[];
}

/** Reads the stored ids; the first format kept one list per session id and is merged. */
export function readFavorites(cwd: string): string[] {
  const stored = readJson<unknown>(favoritesFile(cwd));
  if (!stored || typeof stored !== "object") return [];
  const lists = Array.isArray((stored as Stored).turns) ? [(stored as Stored).turns] : Object.values(stored);
  const ids = lists.flatMap((list) => (Array.isArray(list) ? list : [])).filter((id) => typeof id === "string");
  return [...new Set(ids)];
}

/** Marks or unmarks a turn and returns the marked ids. Re-reads first so other viewers' marks survive. */
export function toggleFavorite(cwd: string, turnId: string): string[] {
  const ids = readFavorites(cwd);
  const next = ids.includes(turnId) ? ids.filter((id) => id !== turnId) : [...ids, turnId];
  writeJson(favoritesFile(cwd), { turns: next } satisfies Stored);
  return next;
}
