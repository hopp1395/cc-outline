import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** git's well-known empty tree: the diff base for repositories without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface FileChange {
  path: string;
  oldPath?: string;
  /** Single-letter status: M, A, D, R, C, U (conflict) or ? (untracked). */
  status: string;
  added?: number;
  removed?: number;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Top-level directory of the repository containing `cwd`, or undefined outside a repository. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return undefined;
  }
}

async function diffBase(root: string): Promise<string> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return "HEAD";
  } catch {
    return EMPTY_TREE;
  }
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parseStatus(out: string): FileChange[] {
  const parts = out.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    let status: string;
    if (x === "?") status = "?";
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) status = "U";
    else status = x !== " " ? x : y;
    const change: FileChange = { path, status };
    // Renames and copies are followed by the source path as a separate field.
    if (x === "R" || x === "C") change.oldPath = parts[++i];
    files.push(change);
  }
  return files;
}

/** Parses `git diff --numstat -z` output into path → [added, removed]. */
export function parseNumstat(out: string): Map<string, [number, number]> {
  const stats = new Map<string, [number, number]>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    // A rename has an empty path field followed by source and destination paths.
    const path = m[3] === "" ? parts[(i += 2)] : m[3];
    stats.set(path, [m[1] === "-" ? 0 : Number(m[1]), m[2] === "-" ? 0 : Number(m[2])]);
  }
  return stats;
}

/** Working tree and index changes relative to HEAD, sorted by path. */
export async function listChanges(root: string): Promise<FileChange[]> {
  const base = await diffBase(root);
  const [status, numstat] = await Promise.all([
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["diff", base, "--numstat", "-z", "-M", "--no-ext-diff"]),
  ]);
  const stats = parseNumstat(numstat);
  const files = parseStatus(status);
  await Promise.all(
    files.map(async (f) => {
      const s = f.status === "?" ? await untrackedStat(root, f.path) : stats.get(f.path);
      if (s) [f.added, f.removed] = s;
    }),
  );
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** numstat does not cover untracked files: count their lines, skipping large or binary ones. */
async function untrackedStat(root: string, path: string): Promise<[number, number] | undefined> {
  try {
    const buf = await readFile(join(root, path));
    if (buf.length > 1024 * 1024 || buf.subarray(0, 8000).includes(0)) return undefined;
    const text = buf.toString("utf8");
    return [text.split("\n").length - (text.endsWith("\n") ? 1 : 0), 0];
  } catch {
    return undefined;
  }
}

export interface BranchStatus {
  /** Branch name; undefined when HEAD is detached. */
  branch?: string;
  /** Upstream such as origin/main; undefined when none is set. */
  upstream?: string;
  /** Commits to push (outgoing). */
  ahead: number;
  /** Commits to pull (incoming), as of the last fetch. */
  behind: number;
}

/** Parses the `# branch.*` headers of `git status --porcelain=v2 --branch -z`. */
export function parseBranch(out: string): BranchStatus {
  const status: BranchStatus = { ahead: 0, behind: 0 };
  for (const entry of out.split("\0")) {
    const [marker, name, ...args] = entry.split(" ");
    if (marker !== "#") continue;
    if (name === "branch.head" && args[0] !== "(detached)") status.branch = args.join(" ");
    else if (name === "branch.upstream") status.upstream = args.join(" ");
    else if (name === "branch.ab") {
      const m = /^\+(\d+) -(\d+)$/.exec(args.join(" "));
      if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
    }
  }
  return status;
}

/** Current branch and how far it is ahead of and behind its upstream. Does not fetch. */
export async function branchStatus(root: string): Promise<BranchStatus> {
  return parseBranch(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"]));
}

export interface Commit {
  hash: string;
  /** When it was committed, relative: "2 days ago". */
  when: string;
  subject: string;
}

/** The last `count` commits of HEAD, newest first; none in a repository without commits. */
export async function recentCommits(root: string, count = 5): Promise<Commit[]> {
  try {
    const out = await git(root, ["log", `-n${count}`, "--format=%h%x09%cr%x09%s"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, when, ...subject] = line.split("\t");
        return { hash, when, subject: subject.join("\t") };
      });
  } catch {
    return [];
  }
}

/** Unified diff of one file against HEAD. Untracked files are shown as entirely added. */
export async function fileDiff(root: string, change: FileChange): Promise<string> {
  if (change.status === "?") return untrackedDiff(root, change.path);
  const base = await diffBase(root);
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  return git(root, ["diff", base, "-M", "--no-color", "--no-ext-diff", "-U3", "--", ...paths]);
}

export type FileContent = { kind: "text"; text: string } | { kind: "deleted" } | { kind: "binary" };

/** The file as it is in the working tree now, i.e. after the change. */
export async function fileContent(root: string, change: FileChange): Promise<FileContent> {
  if (change.status === "D") return { kind: "deleted" };
  let buf: Buffer;
  try {
    buf = await readFile(join(root, change.path));
  } catch {
    return { kind: "deleted" };
  }
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary" };
  return { kind: "text", text: buf.toString("utf8") };
}

async function untrackedDiff(root: string, path: string): Promise<string> {
  const buf = await readFile(join(root, path));
  if (buf.subarray(0, 8000).includes(0)) return "Binary files differ\n";
  const lines = buf.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "";
  return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n") + "\n";
}
