import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot, type FileChange } from "./git.js";

/** A git repository the Changes view shows. */
export interface Repo {
  /** Its top-level directory. */
  root: string;
  /** Its path below the base, with `/`; "" for the repository the viewer runs in. */
  rel: string;
}

export interface FoundRepos {
  /** Where the search started: the top level of the repository the cwd is in, else the cwd. */
  base: string;
  /** The base's repository first (if it is one), then the others by path. */
  repos: Repo[];
}

/** How many folder levels below the base are searched for repositories. */
export const REPO_DEPTH = 3;

/** Folders that are not searched: build output and dependencies, which hold no repositories of one's own but many folders. */
const SKIPPED = new Set(["node_modules", "bin", "obj"]);

/**
 * The repositories of `cwd`: the one it is in, and with `nested` every folder
 * up to `REPO_DEPTH` levels below that one's top level (or below `cwd`, when
 * it is in none) that holds a `.git` folder or file: nested repositories,
 * submodules and worktrees alike, also inside ignored folders. Hidden folders
 * and those of `SKIPPED` are left out.
 */
export async function findRepos(cwd: string, nested: boolean): Promise<FoundRepos> {
  const top = await repoRoot(cwd);
  const base = resolve(top ?? cwd);
  const repos: Repo[] = top ? [{ root: base, rel: "" }] : [];
  if (nested) await walk(base, "", 1, repos);
  repos.sort((a, b) => (a.rel === "" ? -1 : b.rel === "" ? 1 : a.rel.localeCompare(b.rel)));
  return { base, repos };
}

async function walk(dir: string, rel: string, depth: number, repos: Repo[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED.has(e.name))
      .map(async (e) => {
        const path = join(dir, e.name);
        const sub = rel ? `${rel}/${e.name}` : e.name;
        if (existsSync(join(path, ".git"))) repos.push({ root: path, rel: sub });
        if (depth < REPO_DEPTH) await walk(path, sub, depth + 1, repos);
      }),
  );
}

/** The paths of the repositories below `repo`, relative to it. */
export function nestedPaths(repo: Repo, repos: Repo[]): string[] {
  const prefix = repo.rel ? `${repo.rel}/` : "";
  return repos.filter((r) => r.rel !== repo.rel && r.rel.startsWith(prefix)).map((r) => r.rel.slice(prefix.length));
}

/**
 * `files` without the repositories below: git lists a nested repository as an
 * untracked folder (`tools/bar/`) and a submodule as one changed entry; their
 * own changes show under them instead.
 */
export function withoutNested(files: FileChange[], nested: string[]): FileChange[] {
  if (nested.length === 0) return files;
  return files.filter((f) => {
    const path = f.path.replace(/\/$/, "");
    return !nested.some((n) => path === n || path.startsWith(`${n}/`));
  });
}
