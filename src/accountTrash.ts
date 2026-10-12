import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Account } from "./account.js";
import { accountsHome, claudeBinDir } from "./addAccount.js";
import { removeFavorite } from "./favorites.js";
import { inClaudeDir, readJson, writeJson } from "./transcript/locate.js";
import { runningSessions } from "./transcript/trash.js";
import { isAlive } from "./viewer.js";

/**
 * Deleting an account: its config folder and the start scripts that run Claude Code under it move to a trash of
 * their own in the default folder (`~/.claude/cco/trash/accounts/`), which every viewer sees whatever account it
 * runs under, and can come back from there. The default folder and the active account are never deleted, nor one
 * a Claude Code or a cco viewer runs with; on Windows the move itself fails while a process holds a file in it.
 */

/** An account in the trash: what it was, where its parts came from and where they are now. */
export interface AccountTrashEntry {
  /** The entry's folder name in the trash: `<folder>-<deletedAt>`. */
  id: string;
  /** Epoch ms. */
  deletedAt: number;
  /** The account as it was read, so the trash can show it without its folder. */
  account: Account;
  /** The config folder and where it is now. */
  folder: { from: string; to: string };
  /** The start scripts moved with it. */
  scripts: { from: string; to: string }[];
  /** Bytes of the folder, and how many sessions (transcripts) it held. */
  size: number;
  sessions: number;
}

export function accountTrashRoot(home = accountsHome.get()): string {
  return join(home, ".claude", "cco", "trash", "accounts");
}

const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Bytes below `path`, without following links. */
export function folderSize(path: string): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    return readdirSync(path).reduce((sum, name) => sum + folderSize(join(path, name)), 0);
  } catch {
    return 0;
  }
}

/** How many sessions (transcripts) the account of `dir` keeps, over all projects. */
export function sessionCount(dir: string): number {
  const projects = join(dir, "projects");
  try {
    return readdirSync(projects).reduce((n, slug) => {
      try {
        return n + readdirSync(join(projects, slug)).filter((f) => f.endsWith(".jsonl")).length;
      } catch {
        return n;
      }
    }, 0);
  } catch {
    return 0;
  }
}

/** The folder a start script sets `CLAUDE_CONFIG_DIR` to, with the home folder's variables put in. */
export function scriptFolder(text: string, home = accountsHome.get()): string | undefined {
  const value = /CLAUDE_CONFIG_DIR=("?)([^"\r\n]+)\1/.exec(text)?.[2]?.trim();
  if (!value) return undefined;
  const expanded = value.replace(/^(%USERPROFILE%|\$USERPROFILE|\$\{USERPROFILE\}|\$HOME|\$\{HOME\}|~)(?=[\\/]|$)/i, home);
  // A script written for Windows names the folder with backslashes, which are no separators elsewhere.
  return resolve(expanded.replace(/\\/g, "/"));
}

/** The start scripts that run Claude Code under `dir`: in the folder next to claude and in `~/.local/bin`. */
export function startScriptsOf(dir: string, home = accountsHome.get()): string[] {
  const folders = [claudeBinDir(process.env, process.platform, home).dir, join(home, ".local", "bin")].filter((d, i, all) => all.findIndex((x) => same(x, d)) === i);
  const found: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      // Scripts only: no ending, or one of a shell's; small enough to be one.
      if (!/^[^.]+(\.(cmd|bat|ps1|sh))?$/i.test(name)) continue;
      const file = join(folder, name);
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 4096) continue;
        const target = scriptFolder(readFileSync(file, "utf8"), home);
        if (target && same(target, dir)) found.push(file);
      } catch {
        // gone or unreadable
      }
    }
  }
  return found;
}

/** The cco viewers that run under the account of `dir` (their pids), from that folder's registrations. */
export function accountViewers(dir: string): number[] {
  const state = join(dir, "cco");
  let names: string[];
  try {
    names = readdirSync(state).filter((n) => /\.viewer(-\d+)?\.json$/.test(n));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const pid = readJson<{ pid?: unknown }>(join(state, n))?.pid;
    return typeof pid === "number" && pid !== process.pid && isAlive(pid) ? [pid] : [];
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Why the account of `dir` may not be deleted, or undefined when it may. `active`: the account the viewer follows. */
export function accountDeleteBlocker(dir: string, active: string | undefined, home = accountsHome.get()): string | undefined {
  if (same(dir, join(home, ".claude"))) return "~/.claude is the default account: it can't be deleted";
  if (active && same(dir, active)) return "it is the account of the Claude Code this viewer follows";
  const running = inClaudeDir(dir, runningSessions).size;
  if (running) return `${plural(running, "Claude Code")} ${running === 1 ? "runs" : "run"} with it`;
  const viewers = accountViewers(dir);
  if (viewers.length) return `a cco viewer runs with it (pid ${viewers.join(", ")})`;
  return undefined;
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

const manifestOf = (id: string, home?: string) => join(accountTrashRoot(home), id, "manifest.json");

/** What moving the account to the trash takes along: the scripts, the size and the sessions. */
export function accountTrashPlan(account: Account, home = accountsHome.get()): { scripts: string[]; size: number; sessions: number } {
  return { scripts: startScriptsOf(account.dir, home), size: folderSize(account.dir), sessions: sessionCount(account.dir) };
}

/**
 * Moves an account to the trash: the folder first (it fails while a process holds a file in it, and then nothing
 * has moved), then its start scripts. Throws with the reason when it may not or could not.
 */
export function trashAccount(account: Account, active: string | undefined, home = accountsHome.get()): AccountTrashEntry {
  const blocker = accountDeleteBlocker(account.dir, active, home);
  if (blocker) throw new Error(blocker);
  const plan = accountTrashPlan(account, home);
  const deletedAt = Date.now();
  const id = `${basename(account.dir)}-${deletedAt}`;
  const target = join(accountTrashRoot(home), id);
  const entry: AccountTrashEntry = {
    id,
    deletedAt,
    account,
    folder: { from: account.dir, to: join(target, "folder") },
    scripts: plan.scripts.map((from) => ({ from, to: join(target, "scripts", basename(from)) })),
    size: plan.size,
    sessions: plan.sessions,
  };
  // Written first, so an interrupted move can still be traced and restored.
  mkdirSync(target, { recursive: true });
  writeJson(manifestOf(id, home), entry);
  try {
    // No fallback over drives here: a copy that stops halfway would leave two halves.
    renameSync(entry.folder.from, entry.folder.to);
  } catch (err) {
    rmSync(target, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") throw new Error(`the folder is in use by a process (${code}): close it and try again`);
    throw new Error(`the folder could not be moved: ${(err as Error).message}`);
  }
  const failed: string[] = [];
  for (const s of entry.scripts) {
    try {
      move(s.from, s.to);
    } catch {
      failed.push(basename(s.from));
    }
  }
  if (failed.length) {
    entry.scripts = entry.scripts.filter((s) => !failed.includes(basename(s.from)));
    writeJson(manifestOf(id, home), entry);
  }
  return entry;
}

/** The accounts in the trash, most recently deleted first. */
export function listAccountTrash(home = accountsHome.get()): AccountTrashEntry[] {
  let ids: string[];
  try {
    ids = readdirSync(accountTrashRoot(home));
  } catch {
    return [];
  }
  return ids
    .flatMap((id) => {
      const entry = readJson<AccountTrashEntry>(manifestOf(id, home));
      return entry && entry.account && entry.folder ? [{ ...entry, id, scripts: entry.scripts ?? [] }] : [];
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Moves an account back from the trash. Refuses, without moving anything, if its folder or a script exists again. */
export function restoreAccount(id: string, home = accountsHome.get()): AccountTrashEntry {
  const entry = listAccountTrash(home).find((e) => e.id === id);
  if (!entry) throw new Error("not in the trash");
  const taken = [entry.folder, ...entry.scripts].find((i) => existsSync(i.from));
  if (taken) throw new Error(`can't restore: ${basename(taken.from)} exists again`);
  if (existsSync(entry.folder.to)) move(entry.folder.to, entry.folder.from);
  for (const s of entry.scripts) if (existsSync(s.to)) move(s.to, s.from);
  rmSync(join(accountTrashRoot(home), id), { recursive: true, force: true });
  return entry;
}

/** Deletes an account in the trash for good, and its mark in the Accounts view (`marksCwd`: any project, the list is global). */
export function purgeAccount(id: string, marksCwd?: string, home = accountsHome.get()): void {
  const entry = listAccountTrash(home).find((e) => e.id === id);
  rmSync(join(accountTrashRoot(home), id), { recursive: true, force: true });
  if (entry && marksCwd) removeFavorite(marksCwd, "accounts", entry.folder.from);
}

/** Deletes every account in the trash for good; returns how many there were. */
export function emptyAccountTrash(marksCwd?: string, home = accountsHome.get()): number {
  const entries = listAccountTrash(home);
  for (const e of entries) purgeAccount(e.id, marksCwd, home);
  return entries.length;
}

/** A size for people: `512 B`, `3.4 MB`. */
export function sizeText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
