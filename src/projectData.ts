import { existsSync, rmSync } from "node:fs";
import { favoritesFile, positionsFile, restoreFile, sessionViewsFile } from "./transcript/locate.js";
import { L } from "./i18n/index.js";

/**
 * What cco remembers per project besides the settings: marks, list
 * positions, each session's view and placement, and whether the viewer was
 * open at the last exit. Hook state (active session, running viewer) is not
 * part of it: it describes what runs now, not a preference.
 */
const DATA: { id: string; file: (cwd: string) => string }[] = [
  { id: "marks", file: favoritesFile },
  { id: "positions", file: positionsFile },
  { id: "views", file: sessionViewsFile },
  { id: "restore", file: restoreFile },
];

/** The data files of a project, named in the current language. */
export const projectDataFiles = (): { name: string; file: (cwd: string) => string }[] => DATA.map((d) => ({ name: L().core.data[d.id] ?? d.id, file: d.file }));

/** The project's data files that exist, with what they hold. */
export function projectData(cwd: string): { name: string; path: string }[] {
  return projectDataFiles().map((d) => ({ name: d.name, path: d.file(cwd) })).filter((d) => existsSync(d.path));
}

/** Deletes the project's data files; returns what was deleted. */
export function clearProjectData(cwd: string): string[] {
  const present = projectData(cwd);
  for (const d of present) rmSync(d.path, { force: true });
  return present.map((d) => d.name);
}
