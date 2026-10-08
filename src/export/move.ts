import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { removeFavorite } from "../favorites.js";
import { forgetScroll } from "../positions.js";
import { forgetSessionView } from "../sessionViews.js";
import { claudeDir, projectSlug } from "../transcript/locate.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { mergeCcoData, relocatedData, walk } from "./archive.js";
import { relocateText, type Relocation } from "./relocate.js";
import { loadSession, sessionCcoData } from "./session.js";

/**
 * Moves a session whose project folder is gone into the project folder `cwd`:
 * its transcripts and their folders (subagents, tool results) go to that
 * project, with the old folder's paths rewritten as an import does; the ids
 * stay. File history and session environment are kept by id and stay where
 * they are. cco's marks, positions and view of it go along. New files are
 * written first and the old ones removed after, so a failure leaves the
 * session where it was.
 */
export function moveSession(s: SessionSummary, cwd: string): void {
  const root = claudeDir();
  const oldDir = dirname(s.path);
  const slugTo = projectSlug(cwd);
  const newDir = join(root, "projects", slugTo);
  const ids = [...(s.continues ?? []), s.id];
  const taken = ids.find((id) => existsSync(join(newDir, `${id}.jsonl`)));
  if (taken) throw new Error(`session ${taken.slice(0, 8)} is in this folder already`);
  const relocation: Relocation = { from: s.cwd, to: cwd, claudeTo: root, slugFrom: basename(oldDir), slugTo, ids: new Map() };
  // Read before anything moves: the marks are found through the session's turns and plans.
  const cco = s.cwd ? sessionCcoData(loadSession(s), s.cwd, cwd) : undefined;
  const items = ids.flatMap((id) => [join(oldDir, `${id}.jsonl`), join(oldDir, id)]).filter((p) => existsSync(p));
  const files = items.flatMap((p) => walk(p, root)).map((rel) => rel.split(sep).join("/"));
  const written: string[] = [];
  try {
    for (const rel of files) {
      const target = join(root, ...rel.split("/").map((p, i) => (i === 1 ? slugTo : p)));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, relocatedData(rel, readFileSync(join(root, rel)), relocation));
      written.push(target);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  for (const p of items) rmSync(p, { recursive: true, force: true });
  try {
    if (readdirSync(oldDir).length === 0) rmdirSync(oldDir);
  } catch {
    // Left for another time; an empty folder does no harm.
  }
  if (cco && s.cwd) {
    try {
      mergeCcoData(cwd, JSON.parse(relocateText(JSON.stringify(cco), relocation, true)), s.id);
      for (const kind of ["turns", "plans", "sessions"] as const) for (const key of cco.favorites[kind]) removeFavorite(s.cwd, kind, key);
      for (const [list, scroll] of Object.entries(cco.positions)) forgetScroll(s.cwd, list as "chat" | "plan" | "sessions", Object.keys(scroll));
      forgetSessionView(s.cwd, s.id);
    } catch {
      // The session has moved; its marks and positions are a nicety.
    }
  }
}
