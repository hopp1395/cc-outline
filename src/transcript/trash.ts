import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { removeFavorite } from "../favorites.js";
import { isAlive } from "../viewer.js";
import { claudeDir, projectDir, projectSlug, writeJson } from "./locate.js";
import type { SessionSummary } from "./sessions.js";

/** A session moved to cco's trash: where each part came from and where it is now. */
export interface TrashEntry {
  id: string;
  /** Epoch ms. */
  deletedAt: number;
  items: { from: string; to: string }[];
  /** What the Sessions view showed, so the trash can show it without the transcript. */
  summary: SessionSummary;
}

/**
 * Everything Claude Code keeps for one session that belongs to it alone: the
 * transcript, its folder (subagents, title), the /rewind file states and the
 * session environment. The shared history.jsonl and plan files stay.
 */
export function sessionItems(cwd: string, id: string): string[] {
  const root = claudeDir();
  return [
    join(projectDir(cwd), `${id}.jsonl`),
    join(projectDir(cwd), id),
    join(root, "file-history", id),
    join(root, "session-env", id),
  ].filter((p) => existsSync(p));
}

/** Ids of sessions whose Claude Code process is still running (from ~/.claude/sessions/<pid>.json). */
export function runningSessionIds(): Set<string> {
  const dir = join(claudeDir(), "sessions");
  const ids = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return ids;
  }
  for (const name of names) {
    try {
      const info = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown };
      if (typeof info.sessionId === "string" && typeof info.pid === "number" && isAlive(info.pid)) ids.add(info.sessionId);
    } catch {
      // Being rewritten or not ours: skip it.
    }
  }
  return ids;
}

function trashDir(cwd: string): string {
  return join(claudeDir(), "cco", "trash", projectSlug(cwd));
}

function manifestFile(cwd: string, id: string): string {
  return join(trashDir(cwd), id, "manifest.json");
}

/** Renames, or copies and removes when source and target are on different drives. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Why a session may not be deleted, or undefined when it may. */
export function deleteBlocker(id: string, activeId: string | undefined, running: Set<string>): string | undefined {
  if (id === activeId) return "the active session can't be deleted";
  if (running.has(id)) return "the session is running in another Claude Code";
  return undefined;
}

/** Moves a session into the trash. Throws when it is active or running. */
export function trashSession(cwd: string, summary: SessionSummary, activeId?: string): TrashEntry {
  const blocker = deleteBlocker(summary.id, activeId, runningSessionIds());
  if (blocker) throw new Error(blocker);
  const root = claudeDir();
  const target = join(trashDir(cwd), summary.id);
  if (existsSync(target)) throw new Error("a session with this id is already in the trash");
  const entry: TrashEntry = {
    id: summary.id,
    deletedAt: Date.now(),
    items: sessionItems(cwd, summary.id).map((from) => ({ from, to: join(target, relative(root, from)) })),
    summary,
  };
  // Written first, so an interrupted move can still be traced and restored.
  mkdirSync(target, { recursive: true });
  writeJson(manifestFile(cwd, summary.id), entry);
  for (const { from, to } of entry.items) move(from, to);
  return entry;
}

/** Sessions in the trash of the project, most recently deleted first. */
export function listTrash(cwd: string): TrashEntry[] {
  let ids: string[];
  try {
    ids = readdirSync(trashDir(cwd));
  } catch {
    return [];
  }
  const entries: TrashEntry[] = [];
  for (const id of ids) {
    try {
      entries.push(JSON.parse(readFileSync(manifestFile(cwd, id), "utf8")) as TrashEntry);
    } catch {
      // No readable manifest: not an entry we can show or restore.
    }
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Moves a session back from the trash. Refuses, without moving anything, if one of its places is taken again. */
export function restoreSession(cwd: string, id: string): void {
  const entry = listTrash(cwd).find((e) => e.id === id);
  if (!entry) throw new Error("not in the trash");
  const taken = entry.items.find((i) => existsSync(i.from));
  if (taken) throw new Error(`can't restore: ${taken.from} exists again`);
  for (const { from, to } of entry.items) if (existsSync(to)) move(to, from);
  rmSync(join(trashDir(cwd), id), { recursive: true, force: true });
  removeIfEmpty(trashDir(cwd));
}

/** Deletes a session from the trash for good, and its mark with it. */
export function purgeSession(cwd: string, id: string): void {
  rmSync(join(trashDir(cwd), id), { recursive: true, force: true });
  removeFavorite(cwd, "sessions", id);
  removeIfEmpty(trashDir(cwd));
}

/** Drops the project's trash folder once nothing is left in it. */
function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

/** Deletes every session in the project's trash for good; returns how many there were. */
export function emptyTrash(cwd: string): number {
  const entries = listTrash(cwd);
  for (const e of entries) purgeSession(cwd, e.id);
  // Leftovers without a manifest go as well.
  rmSync(trashDir(cwd), { recursive: true, force: true });
  return entries.length;
}
