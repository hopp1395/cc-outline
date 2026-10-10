import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ago, gitDirs, gitOperation, repoInfo, repoLive, shortUrl, shownRemote, STALE_FETCH_MS } from "../src/git/info.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

/** A folder with a `.git` folder of the files given, without git. */
function fakeRepo(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cco-info-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, ".git", path, ".."), { recursive: true });
    writeFileSync(join(root, ".git", path), text);
  }
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

describe("gitDirs", () => {
  it("finds the .git folder, and follows a .git file to a worktree's or submodule's", async () => {
    const root = fakeRepo();
    expect(await gitDirs(root)).toEqual({ dir: join(root, ".git"), common: join(root, ".git"), linked: false });

    const main = fakeRepo({ "worktrees/wt/commondir": "../..\n" });
    const wt = mkdtempSync(join(tmpdir(), "cco-info-wt-"));
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(await gitDirs(wt)).toEqual({ dir: join(main, ".git", "worktrees", "wt"), common: join(main, ".git"), linked: true });

    expect(await gitDirs(mkdtempSync(join(tmpdir(), "cco-info-none-")))).toBeUndefined();
  });
});

describe("gitOperation", () => {
  const operation = async (files: Record<string, string>) => gitOperation((await gitDirs(fakeRepo(files)))!);

  it("names the operation in progress, a rebase with its step", async () => {
    expect(await operation({})).toBeUndefined();
    expect(await operation({ "rebase-merge/msgnum": "3\n", "rebase-merge/end": "7\n" })).toBe("REBASE 3/7");
    expect(await operation({ "rebase-apply/next": "1", "rebase-apply/last": "2" })).toBe("REBASE 1/2");
    expect(await operation({ "rebase-apply/applying": "", "rebase-apply/next": "1", "rebase-apply/last": "2" })).toBe("AM 1/2");
    expect(await operation({ MERGE_HEAD: "abc" })).toBe("MERGE");
    expect(await operation({ CHERRY_PICK_HEAD: "abc" })).toBe("CHERRY-PICK");
    expect(await operation({ REVERT_HEAD: "abc" })).toBe("REVERT");
    expect(await operation({ BISECT_LOG: "" })).toBe("BISECT");
  });
});

describe("ago", () => {
  it("says how long ago, short", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(3 * 3600_000)).toBe("3 h ago");
    expect(ago(24 * 3600_000)).toBe("1 day ago");
    expect(ago(50 * 3600_000)).toBe("2 days ago");
  });
});

describe("remotes", () => {
  it("shortens the usual URL forms to host and path", () => {
    expect(shortUrl("git@github.com:hopp1395/cc-outline.git")).toBe("github.com/hopp1395/cc-outline");
    expect(shortUrl("https://user@github.com/hopp1395/cc-outline.git")).toBe("github.com/hopp1395/cc-outline");
    expect(shortUrl("ssh://git@host.example:2222/team/repo")).toBe("host.example/team/repo");
    expect(shortUrl("C:/repos/bare.git")).toBe("C:/repos/bare.git");
  });

  it("shows the upstream's remote, else origin, else the first", () => {
    const remotes = [
      { name: "fork", url: "a" },
      { name: "origin", url: "b" },
      { name: "fork/x", url: "c" },
    ];
    expect(shownRemote(remotes, "fork/main")?.url).toBe("a");
    expect(shownRemote(remotes, "fork/x/main")?.url).toBe("c");
    expect(shownRemote(remotes, undefined)?.url).toBe("b");
    expect(shownRemote([remotes[0]], undefined)?.url).toBe("a");
    expect(shownRemote([], "origin/main")).toBeUndefined();
  });
});

describe("repoLive", () => {
  it("reads the last fetch, the stashes, the tag and the commit count", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-info-live-"));
    git(root, "init", "-q");
    const empty = await repoLive(root, await gitDirs(root));
    expect(empty).toEqual({ stashes: 0 });

    git(root, "commit", "-q", "--allow-empty", "-m", "one");
    git(root, "tag", "v1.0.0");
    git(root, "commit", "-q", "--allow-empty", "-m", "two");
    writeFileSync(join(root, ".git", "logs", "refs", "stash"), "a\nb\n", { flag: "w" });
    writeFileSync(join(root, ".git", "FETCH_HEAD"), "");
    const now = Date.now();
    const fetched = (now - 2 * STALE_FETCH_MS) / 1000;
    utimesSync(join(root, ".git", "FETCH_HEAD"), fetched, fetched);
    const live = await repoLive(root, await gitDirs(root), now);
    expect(live).toMatchObject({ stashes: 2, commitCount: 2, fetched: "2 days ago", staleFetch: true });
    expect(live.describe).toMatch(/^v1\.0\.0-1-g[0-9a-f]+$/);
  });
});

describe("repoInfo", () => {
  it("reads the remotes, the identity and what kind of repository it is", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-info-repo-"));
    git(root, "init", "-q");
    git(root, "remote", "add", "origin", "git@github.com:a/b.git");
    git(root, "config", "user.name", "Local Name");
    git(root, "config", "user.email", "local@example.com");
    writeFileSync(join(root, ".git", "shallow"), "");
    const info = await repoInfo(root, await gitDirs(root));
    expect(info.remotes).toEqual([{ name: "origin", url: "git@github.com:a/b.git" }]);
    expect(info.user).toEqual({ name: "Local Name", email: "local@example.com" });
    expect(info.kinds).toEqual(["shallow"]);
  });

  it("tells a worktree from a submodule", async () => {
    const main = fakeRepo({ "worktrees/wt/commondir": "../..\n", "modules/sub/HEAD": "" });
    const wt = mkdtempSync(join(tmpdir(), "cco-info-wt-"));
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect((await repoInfo(wt, await gitDirs(wt))).kinds).toEqual([`worktree of ${main}`]);
    const sub = mkdtempSync(join(tmpdir(), "cco-info-sub-"));
    writeFileSync(join(sub, ".git"), `gitdir: ${join(main, ".git", "modules", "sub")}\n`);
    expect((await repoInfo(sub, await gitDirs(sub))).kinds).toEqual(["submodule"]);
  });
});
