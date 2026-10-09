import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listChanges, recentCommits } from "../src/git/git.js";
import { findRepos, nestedPaths, withoutNested, type Repo } from "../src/git/repos.js";
import { gitEntries, repoLabel, REPO_LIMIT } from "../src/tui/GitView.js";
import { isLoadMore } from "../src/tui/loadMore.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd });

/** A repository at `dir`, without commits: git is slow to start on Windows. */
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
}

/** What the search looks for, without git: a `.git` folder, or a `.git` file as in worktrees and submodules. */
function fakeRepo(dir: string, file = false) {
  mkdirSync(file ? dir : join(dir, ".git"), { recursive: true });
  if (file) writeFileSync(join(dir, ".git"), "gitdir: elsewhere\n");
}

describe("findRepos", () => {
  it("finds the repository around the folder and those below, by path, and skips hidden and build folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-repos-"));
    repo(root);
    fakeRepo(join(root, "tools", "bar"));
    fakeRepo(join(root, "lib"));
    fakeRepo(join(root, "a", "b", "c"));
    fakeRepo(join(root, "a", "b", "c", "too-deep"));
    fakeRepo(join(root, "node_modules", "dep"));
    fakeRepo(join(root, ".hidden"));
    fakeRepo(join(root, "wt"), true);

    const found = await findRepos(join(root, "tools"), true);
    expect(found.base).toBe(resolve(root));
    expect(found.repos.map((r) => r.rel)).toEqual(["", "a/b/c", "lib", "tools/bar", "wt"]);
    expect((await findRepos(root, false)).repos.map((r) => r.rel)).toEqual([""]);
  });

  it("searches below a folder that is no repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-repos-plain-"));
    fakeRepo(join(root, "one"));
    mkdirSync(join(root, "empty"));
    const found = await findRepos(root, true);
    expect(found.base).toBe(resolve(root));
    expect(found.repos).toEqual([{ root: join(resolve(root), "one"), rel: "one" }]);
    expect((await findRepos(root, false)).repos).toEqual([]);
  });

  it("leaves the nested repositories out of the one around them", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-repos-nested-"));
    repo(root);
    repo(join(root, "tools", "bar"));
    writeFileSync(join(root, "tools", "bar", "new.cs"), "x\n");
    writeFileSync(join(root, "tools", "other.cs"), "y\n");
    const { repos } = await findRepos(root, true);
    const files = await listChanges(root);
    expect(files.map((f) => f.path)).toEqual(["tools/bar/", "tools/other.cs"]);
    expect(withoutNested(files, nestedPaths(repos[0], repos)).map((f) => f.path)).toEqual(["tools/other.cs"]);
    expect((await listChanges(repos[1].root)).map((f) => f.path)).toEqual(["new.cs"]);
  });
});

describe("nestedPaths", () => {
  it("names the repositories below one, relative to it", () => {
    const repos: Repo[] = [
      { root: "/r", rel: "" },
      { root: "/r/a", rel: "a" },
      { root: "/r/a/b", rel: "a/b" },
      { root: "/r/ab", rel: "ab" },
    ];
    expect(nestedPaths(repos[0], repos)).toEqual(["a", "a/b", "ab"]);
    expect(nestedPaths(repos[1], repos)).toEqual(["b"]);
    expect(nestedPaths(repos[3], repos)).toEqual([]);
  });
});

describe("recentCommits", () => {
  it("lists the last commits, none without any", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-commits-"));
    repo(root);
    git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const commits = await recentCommits(root);
    expect(commits).toHaveLength(1);
    expect(commits[0].subject).toBe("init");
    expect(await recentCommits(mkdtempSync(join(tmpdir(), "cco-commits-none-")))).toEqual([]);
  });
});

describe("gitEntries", () => {
  const repos: Repo[] = Array.from({ length: REPO_LIMIT + 2 }, (_, i) => ({ root: `/r${i}`, rel: i === 0 ? "" : `r${i}` }));
  const file = { path: "x.cs", status: "M" };

  it("lists the files per repository, one entry for a clean one, and load more past the limit", () => {
    const states = Object.fromEntries(repos.map((r, i) => [r.root, { files: i === 1 ? [file] : [] }]));
    const items = gitEntries(repos, states, false);
    expect(items.map((e) => (isLoadMore(e) ? "more" : e.key))).toEqual([
      "repo:",
      "r1/x.cs",
      ...repos.slice(2, REPO_LIMIT).map((r) => `repo:${r.rel}`),
      "more",
    ]);
    expect(gitEntries(repos, states, true).some(isLoadMore)).toBe(false);
    // Until the others are read, load more stays.
    const partial = Object.fromEntries(repos.slice(0, REPO_LIMIT + 1).map((r) => [r.root, { files: [] }]));
    expect(gitEntries(repos, partial, true).filter(isLoadMore)).toHaveLength(1);
  });

  it("keys the base repository's files by their own path", () => {
    const items = gitEntries(repos.slice(0, 1), { "/r0": { files: [file] } }, false);
    expect(items).toEqual([{ repo: repos[0], file, key: "x.cs" }]);
  });
});

describe("repoLabel", () => {
  it("names a repository by its path and branch, the base's by its folder", () => {
    expect(repoLabel({ root: "/w/proj", rel: "" }, "/w/proj", { branch: "main", ahead: 0, behind: 0 })).toBe("proj · main");
    expect(repoLabel({ root: "/w/proj/t", rel: "t" }, "/w/proj", { ahead: 0, behind: 0 })).toBe("t · (detached)");
    expect(repoLabel({ root: "/w/proj/t", rel: "t" }, "/w/proj", undefined)).toBe("t");
  });
});
