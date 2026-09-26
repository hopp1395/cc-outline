import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { removeFavorite } from "../favorites.js";
import { isAlive } from "../viewer.js";
import { claudeDir, writeJson } from "./locate.js";
import type { SessionSummary } from "./sessions.js";

/** A session moved to cco's trash: where each part came from and where it is now. */
export interface TrashEntry {
  id: string;
  /** Project folder name under ~/.claude/projects the session belongs to. */
  slug: string;
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
 * `projectDir` is the session's folder under ~/.claude/projects.
 */
export function sessionItems(projectDir: string, id: string): string[] {
  const root = claudeDir();
  return [
    join(projectDir, `${id}.jsonl`),
    join(projectDir, id),
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

function trashRoot(): string {
  return join(claudeDir(), "cco", "trash");
}

function trashDir(slug: string): string {
  return join(trashRoot(), slug);
}

function manifestFile(slug: string, id: string): string {
  return join(trashDir(slug), id, "manifest.json");
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

/** Drops a folder once nothing is left in it. */
function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

/** Why a session may not be deleted, or undefined when it may. */
export function deleteBlocker(id: string, activeId: string | undefined, running: Set<string>): string | undefined {
  if (id === activeId) return "the active session can't be deleted";
  if (running.has(id)) return "the session is running in another Claude Code";
  return undefined;
}

/** Moves a session into the trash. Throws when it is active or running. */
export function trashSession(summary: SessionSummary, activeId?: string): TrashEntry {
  const blocker = deleteBlocker(summary.id, activeId, runningSessionIds());
  if (blocker) throw new Error(blocker);
  const root = claudeDir();
  const projectDir = dirname(summary.path);
  const slug = basename(projectDir);
  const target = join(trashDir(slug), summary.id);
  if (existsSync(target)) throw new Error("a session with this id is already in the trash");
  const entry: TrashEntry = {
    id: summary.id,
    slug,
    deletedAt: Date.now(),
    items: sessionItems(projectDir, summary.id).map((from) => ({ from, to: join(target, relative(root, from)) })),
    summary,
  };
  // Written first, so an interrupted move can still be traced and restored.
  mkdirSync(target, { recursive: true });
  writeJson(manifestFile(slug, summary.id), entry);
  for (const { from, to } of entry.items) move(from, to);
  return entry;
}

/** Sessions in the trash of one project (`slug`) or of all, most recently deleted first. */
export function listTrash(slug?: string): TrashEntry[] {
  let slugs: string[];
  try {
    slugs = slug ? [slug] : readdirSync(trashRoot());
  } catch {
    return [];
  }
  const entries: TrashEntry[] = [];
  for (const s of slugs) {
    let ids: string[];
    try {
      ids = readdirSync(trashDir(s));
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        entries.push({ ...(JSON.parse(readFileSync(manifestFile(s, id), "utf8")) as TrashEntry), slug: s });
      } catch {
        // No readable manifest: not an entry we can show or restore.
      }
    }
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Moves a session back from the trash. Refuses, without moving anything, if one of its places is taken again. */
export function restoreSession(slug: string, id: string): void {
  const entry = listTrash(slug).find((e) => e.id === id);
  if (!entry) throw new Error("not in the trash");
  const taken = entry.items.find((i) => existsSync(i.from));
  if (taken) throw new Error(`can't restore: ${taken.from} exists again`);
  for (const { from, to } of entry.items) if (existsSync(to)) move(to, from);
  rmSync(join(trashDir(slug), id), { recursive: true, force: true });
  removeIfEmpty(trashDir(slug));
}

/** Deletes a session from the trash for good, and its mark in the project `marksCwd` keeps them for. */
export function purgeSession(slug: string, id: string, marksCwd?: string): void {
  rmSync(join(trashDir(slug), id), { recursive: true, force: true });
  if (marksCwd) removeFavorite(marksCwd, "sessions", id);
  removeIfEmpty(trashDir(slug));
}

/** Deletes every session in the trash of one project (`slug`) or of all for good; returns how many there were. */
export function emptyTrash(slug?: string, marksCwd?: string): number {
  const entries = listTrash(slug);
  for (const e of entries) purgeSession(e.slug, e.id, marksCwd);
  return entries.length;
}
