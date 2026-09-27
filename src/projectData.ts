import { existsSync, rmSync } from "node:fs";
import { favoritesFile, positionsFile, restoreFile, sessionViewsFile } from "./transcript/locate.js";

/**
 * What cco remembers per project besides the settings: marks, list
 * positions, each session's view and placement, and whether the viewer was
 * open at the last exit. Hook state (active session, running viewer) is not
 * part of it: it describes what runs now, not a preference.
 */
export const PROJECT_DATA: { name: string; file: (cwd: string) => string }[] = [
  { name: "marks ★ (turns, files, plans, sessions, days)", file: favoritesFile },
  { name: "selected entries and scroll positions", file: positionsFile },
  { name: "view and placement per session", file: sessionViewsFile },
  { name: "whether the viewer was open at the last exit", file: restoreFile },
];

/** The project's data files that exist, with what they hold. */
export function projectData(cwd: string): { name: string; path: string }[] {
  return PROJECT_DATA.map((d) => ({ name: d.name, path: d.file(cwd) })).filter((d) => existsSync(d.path));
}

/** Deletes the project's data files; returns what was deleted. */
export function clearProjectData(cwd: string): string[] {
  const present = projectData(cwd);
  for (const d of present) rmSync(d.path, { force: true });
  return present.map((d) => d.name);
}
