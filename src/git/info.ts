import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-c", "core.quotepath=off", ...args], { cwd: root, windowsHide: true });
    return stdout;
  } catch {
    return undefined;
  }
}

const readText = (path: string) => readFile(path, "utf8").then((t) => t.trim(), () => undefined);

/**
 * Where a repository's git data is: `dir` its own (per worktree), `common`
 * what its worktrees share (refs, config, stash, shallow). Read from the
 * `.git` folder or file, without starting git.
 */
export interface GitDirs {
  dir: string;
  common: string;
  /** `.git` is a file pointing elsewhere: a worktree or a submodule. */
  linked: boolean;
}

export async function gitDirs(root: string): Promise<GitDirs | undefined> {
  const dotGit = join(root, ".git");
  let dir = dotGit;
  let linked = false;
  try {
    if ((await stat(dotGit)).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? "");
      if (!m) return undefined;
      dir = resolve(root, m[1].trim());
      linked = true;
    }
  } catch {
    return undefined;
  }
  const commondir = await readText(join(dir, "commondir"));
  return { dir, common: commondir ? resolve(dir, commondir) : dir, linked };
}

/**
 * A git operation in progress in the repository, as the shell prompts name
 * them: `REBASE 3/7`, `AM`, `MERGE`, `CHERRY-PICK`, `REVERT`, `BISECT`.
 */
export async function gitOperation(dirs: GitDirs): Promise<string | undefined> {
  const at = (name: string) => join(dirs.dir, name);
  const step = async (now: string, end: string) => {
    const [n, total] = await Promise.all([readText(now), readText(end)]);
    return n && total ? ` ${n}/${total}` : "";
  };
  if (existsSync(at("rebase-merge"))) return "REBASE" + (await step(at("rebase-merge/msgnum"), at("rebase-merge/end")));
  if (existsSync(at("rebase-apply"))) {
    const kind = existsSync(at("rebase-apply/applying")) ? "AM" : "REBASE";
    return kind + (await step(at("rebase-apply/next"), at("rebase-apply/last")));
  }
  if (existsSync(at("MERGE_HEAD"))) return "MERGE";
  if (existsSync(at("CHERRY_PICK_HEAD"))) return "CHERRY-PICK";
  if (existsSync(at("REVERT_HEAD"))) return "REVERT";
  if (existsSync(at("BISECT_LOG"))) return "BISECT";
  return undefined;
}

/** A fetch older than this is shown as stale. */
export const STALE_FETCH_MS = 24 * 60 * 60 * 1000;

/** How long ago, short: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** What changes often, read with every refresh for the selected repository. */
export interface RepoLive {
  /** When it was last fetched, as `ago` says it; undefined if never. */
  fetched?: string;
  /** The last fetch is older than `STALE_FETCH_MS`. */
  staleFetch?: boolean;
  stashes: number;
  /** `git describe --tags`; undefined without a tag. */
  describe?: string;
  /** Commits of HEAD; undefined without any. */
  commitCount?: number;
}

export async function repoLive(root: string, dirs: GitDirs | undefined, now = Date.now()): Promise<RepoLive> {
  const [fetchTimes, stashLog, describe, count] = await Promise.all([
    dirs
      ? Promise.all([dirs.dir, dirs.common].map((d) => stat(join(d, "FETCH_HEAD")).then((s) => s.mtimeMs, () => 0)))
      : Promise.resolve([0]),
    dirs ? readText(join(dirs.common, "logs", "refs", "stash")) : Promise.resolve(undefined),
    git(root, ["describe", "--tags"]),
    git(root, ["rev-list", "--count", "HEAD"]),
  ]);
  const fetchedAt = Math.max(...fetchTimes);
  const live: RepoLive = { stashes: stashLog ? stashLog.split("\n").filter(Boolean).length : 0 };
  if (fetchedAt > 0) {
    live.fetched = ago(now - fetchedAt);
    live.staleFetch = now - fetchedAt > STALE_FETCH_MS;
  }
  if (describe?.trim()) live.describe = describe.trim();
  if (count?.trim()) live.commitCount = Number(count.trim());
  return live;
}

export interface Remote {
  name: string;
  url: string;
}

/** What rarely changes, read when the repository is selected and with each search for repositories. */
export interface RepoInfo {
  remotes: Remote[];
  /** `submodule`, `worktree of <path>`, `shallow`. */
  kinds: string[];
  user: { name?: string; email?: string };
}

/** `git@github.com:a/b.git`, `https://user@github.com/a/b.git`, `ssh://git@host:22/a/b` → `github.com/a/b`; anything else as it is. */
export function shortUrl(url: string): string {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/, "")}`;
  const full = /^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (full) return `${full[1]}/${full[2].replace(/\.git$/, "").replace(/\/$/, "")}`;
  return url;
}

/** The remote to show: the upstream's, else `origin`, else the first. */
export function shownRemote(remotes: Remote[], upstream: string | undefined): Remote | undefined {
  const ofUpstream = upstream
    ? remotes.filter((r) => upstream.startsWith(`${r.name}/`)).sort((a, b) => b.name.length - a.name.length)[0]
    : undefined;
  return ofUpstream ?? remotes.find((r) => r.name === "origin") ?? remotes[0];
}

export async function repoInfo(root: string, dirs: GitDirs | undefined): Promise<RepoInfo> {
  const [remoteOut, userOut] = await Promise.all([
    git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]),
    git(root, ["config", "--get-regexp", "^user\\.(name|email)$"]),
  ]);
  const remotes: Remote[] = [];
  for (const line of (remoteOut ?? "").split("\n")) {
    const m = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  const user: RepoInfo["user"] = {};
  for (const line of (userOut ?? "").split("\n")) {
    const m = /^user\.(name|email) (.*)$/.exec(line.trim());
    if (m) user[m[1] as "name" | "email"] = m[2];
  }
  const kinds: string[] = [];
  if (dirs?.linked) {
    if (dirs.common !== dirs.dir) kinds.push(`worktree of ${basename(dirs.common) === ".git" ? dirname(dirs.common) : dirs.common}`);
    else kinds.push("submodule");
  }
  if (dirs && existsSync(join(dirs.common, "shallow"))) kinds.push("shallow");
  return { remotes, kinds, user };
}
