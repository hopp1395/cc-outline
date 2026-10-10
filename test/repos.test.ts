import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listChanges, recentCommits, type Commit } from "../src/git/git.js";
import { findRepos, nestedPaths, withoutNested, type Repo } from "../src/git/repos.js";
import { COMMIT_LIMIT, gitEntries, repoHeader, repoLabel, repoLines, REPO_LIMIT, type RepoState } from "../src/tui/GitView.js";
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
    // git names the real path: /private/var on macOS, the long name instead of RUNNER~1 on Windows.
    expect(found.base).toBe(resolve(realpathSync.native(root)));
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
  it("lists the last commits, newest first and at most as many as asked, none without any", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-commits-"));
    repo(root);
    for (const m of ["init", "second", "third"]) git(root, "commit", "-q", "--allow-empty", "-m", m);
    const commits = await recentCommits(root, 2);
    expect(commits.map((c) => c.subject)).toEqual(["third", "second"]);
    expect(await recentCommits(mkdtempSync(join(tmpdir(), "cco-commits-none-")), 2)).toEqual([]);
  });
});

describe("repoLines", () => {
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
  const commit = (i: number): Commit => ({ hash: `h${i}`, when: "1 day ago", subject: `commit ${i}` });
  const state: RepoState = {
    files: [
      { path: "a.cs", status: "M", added: 3, removed: 1 },
      { path: "b.png", status: "?" },
      { path: "c.cs", status: "?", added: 2, removed: 0 },
    ],
  };

  it("sums the changes in one line instead of listing the files", () => {
    expect(plain(repoLines(state, undefined))).toEqual(["3 files · +5 -1"]);
    expect(plain(repoLines({ files: [state.files[0]] }, undefined))).toEqual(["1 file · +3 -1"]);
    expect(plain(repoLines({ files: [] }, []))).toEqual(["No changes", "", "No commits yet"]);
  });

  it("counts the commits in the heading and names git log when there are more than the limit", () => {
    const few = plain(repoLines({ files: [] }, [commit(1), commit(2)]));
    expect(few).toEqual(["No changes", "", "Last 2 commits:", "h1  1 day ago  commit 1", "h2  1 day ago  commit 2"]);
    const all = Array.from({ length: COMMIT_LIMIT }, (_, i) => commit(i));
    expect(plain(repoLines({ files: [] }, all)).at(-1)).toBe(`h${COMMIT_LIMIT - 1}  1 day ago  commit ${COMMIT_LIMIT - 1}`);
    const more = plain(repoLines({ files: [] }, [...all, commit(COMMIT_LIMIT)]));
    expect(more).toContain(`Last ${COMMIT_LIMIT} commits:`);
    expect(more).not.toContain(`h${COMMIT_LIMIT}  1 day ago  commit ${COMMIT_LIMIT}`);
    expect(more.at(-1)).toBe("older commits: git log");
    const counted = plain(repoLines({ files: [] }, [...all, commit(COMMIT_LIMIT)], { live: { stashes: 0, commitCount: 1234 } }));
    expect(counted).toContain(`Last ${COMMIT_LIMIT} of 1 234 commits:`);
    expect(plain(repoLines({ files: [] }, [commit(1)], { live: { stashes: 0, commitCount: 1 } }))).toContain("Last 1 commit:");
  });

  it("puts remote and kind, tag and stashes and the identity above the changes, leaving out what is missing", () => {
    const info = {
      remotes: [
        { name: "origin", url: "git@github.com:a/b.git" },
        { name: "fork", url: "https://github.com/c/b.git" },
      ],
      kinds: ["shallow"],
      user: { name: "Jan", email: "jan@example.com" },
    };
    const lines = plain(repoLines({ files: [], branch: { ahead: 0, behind: 0, upstream: "fork/main" } }, [], { info, live: { stashes: 2, describe: "v1.0.0-3-gabc" } }));
    expect(lines.slice(0, 5)).toEqual(["github.com/c/b +1 · shallow", "v1.0.0-3-gabc · 2 stashes", "Jan <jan@example.com>", "", "No changes"]);
    const bare = plain(repoLines({ files: [] }, [], { info: { remotes: [], kinds: [], user: {} }, live: { stashes: 0 } }));
    expect(bare.slice(0, 3)).toEqual(["no user.email", "", "No changes"]);
  });
});

describe("repoHeader", () => {
  const repo: Repo = { root: "/r", rel: "" };
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
  const branch = { branch: "main", upstream: "origin/main", ahead: 2, behind: 1 };

  it("names the operation, branch, upstream and last fetch in one line", () => {
    const lines = plain(repoHeader(repo, { files: [], branch, operation: "REBASE 3/7" }, { stashes: 0, fetched: "3 h ago" }, 80));
    expect(lines[1]).toBe("  REBASE 3/7 · main ↑2 ↓1 · origin/main · fetched 3 h ago");
  });

  it("says never fetched only with an upstream, and nothing before the details are read", () => {
    expect(plain(repoHeader(repo, { files: [], branch }, { stashes: 0 }, 80))[1]).toBe("  main ↑2 ↓1 · origin/main · never fetched");
    expect(plain(repoHeader(repo, { files: [], branch }, undefined, 80))[1]).toBe("  main ↑2 ↓1 · origin/main");
    expect(plain(repoHeader(repo, { files: [], branch: { ahead: 0, behind: 0, branch: "x" } }, { stashes: 0 }, 80))[1]).toBe("  x");
  });
});

describe("gitEntries", () => {
  const repos: Repo[] = Array.from({ length: REPO_LIMIT + 2 }, (_, i) => ({ root: `/r${i}`, rel: i === 0 ? "" : `r${i}` }));
  const file = { path: "x.cs", status: "M" };

  it("lists each repository's own entry before its files, and load more past the limit", () => {
    const states = Object.fromEntries(repos.map((r, i) => [r.root, { files: i === 1 ? [file] : [] }]));
    const items = gitEntries(repos, states, false);
    expect(items.map((e) => (isLoadMore(e) ? "more" : e.key))).toEqual([
      "repo:",
      "repo:r1",
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
    expect(items).toEqual([{ repo: repos[0], key: "repo:" }, { repo: repos[0], file, key: "x.cs" }]);
  });
});

describe("repoLabel", () => {
  it("names a repository by its path and branch, the base's by its folder", () => {
    expect(repoLabel({ root: "/w/proj", rel: "" }, "/w/proj", { branch: "main", ahead: 0, behind: 0 })).toBe("proj · main");
    expect(repoLabel({ root: "/w/proj/t", rel: "t" }, "/w/proj", { ahead: 0, behind: 0 })).toBe("t · (detached)");
    expect(repoLabel({ root: "/w/proj/t", rel: "t" }, "/w/proj", undefined)).toBe("t");
    expect(repoLabel({ root: "/w/proj", rel: "" }, "/w/proj", { branch: "main", ahead: 0, behind: 0 }, "REBASE 3/7")).toBe("proj · main · REBASE 3/7");
  });
});
