import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff.js";
import { branchStatus, fileDiff, listChanges, parseBranch, parseNumstat, parseStatus } from "../src/git/git.js";

describe("parseStatus", () => {
  it("maps porcelain entries including renames and untracked files", () => {
    const out = [" M src/a.cs", "A  new.cs", "R  to.cs", "from.cs", "?? tmp/x.cs", "UU conflict.cs", ""].join("\0");
    expect(parseStatus(out)).toEqual([
      { path: "src/a.cs", status: "M" },
      { path: "new.cs", status: "A" },
      { path: "to.cs", status: "R", oldPath: "from.cs" },
      { path: "tmp/x.cs", status: "?" },
      { path: "conflict.cs", status: "U" },
    ]);
  });
});

describe("parseNumstat", () => {
  it("reads counts, binary markers and renames", () => {
    const out = ["3\t1\ta.cs", "-\t-\timg.png", "2\t0\t", "old.cs", "new.cs", ""].join("\0");
    const stats = parseNumstat(out);
    expect(stats.get("a.cs")).toEqual([3, 1]);
    expect(stats.get("img.png")).toEqual([0, 0]);
    expect(stats.get("new.cs")).toEqual([2, 0]);
  });
});

describe("parseDiff", () => {
  it("numbers lines per side and strips CR, BOM and no-newline markers", () => {
    const diff = [
      "diff --git a/a.cs b/a.cs",
      "--- a/a.cs",
      "+++ b/a.cs",
      "@@ -1,3 +1,3 @@ class A",
      " ﻿using System;\r",
      "-int x = 1;\r",
      "+int x = 2;\r",
      " }",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const { hunks, binary } = parseDiff(diff);
    expect(binary).toBe(false);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { kind: "ctx", text: "using System;", oldNo: 1, newNo: 1 },
      { kind: "del", text: "int x = 1;", oldNo: 2 },
      { kind: "add", text: "int x = 2;", newNo: 2 },
      { kind: "ctx", text: "}", oldNo: 3, newNo: 3 },
    ]);
  });

  it("detects binary diffs", () => {
    expect(parseDiff("Binary files a/x.png and b/x.png differ\n").binary).toBe(true);
  });
});

describe("git integration", () => {
  it("lists tracked and untracked changes with diffs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
        cwd: root,
      });
    git("init", "-q");
    writeFileSync(join(root, "a.cs"), "class A {}\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(root, "a.cs"), "class A { int x; }\n");
    writeFileSync(join(root, "b.cs"), "class B {}\nclass C {}\n");

    const files = await listChanges(root);
    expect(files).toEqual([
      { path: "a.cs", status: "M", added: 1, removed: 1 },
      { path: "b.cs", status: "?", added: 2, removed: 0 },
    ]);
    const modified = parseDiff(await fileDiff(root, files[0]));
    expect(modified.hunks[0].lines.map((l) => l.kind)).toEqual(["del", "add"]);
    const untracked = parseDiff(await fileDiff(root, files[1]));
    expect(untracked.hunks[0].lines.map((l) => [l.kind, l.newNo])).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
  });

  it("counts outgoing and incoming commits against the upstream", async () => {
    const base = mkdtempSync(join(tmpdir(), "cco-branch-"));
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    const origin = join(base, "origin");
    const clone = join(base, "clone");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    run(origin, "commit", "-q", "--allow-empty", "-m", "one");
    run(base, "clone", "-q", origin, clone);
    expect(await branchStatus(clone)).toEqual({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });

    run(clone, "commit", "-q", "--allow-empty", "-m", "local 1");
    run(clone, "commit", "-q", "--allow-empty", "-m", "local 2");
    run(origin, "commit", "-q", "--allow-empty", "-m", "remote");
    run(clone, "fetch", "-q");
    expect(await branchStatus(clone)).toEqual({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
  });
});

describe("parseBranch", () => {
  it("reads branch, upstream and ahead/behind", () => {
    const out = ["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +3 -0", ""].join("\0");
    expect(parseBranch(out)).toEqual({ branch: "main", upstream: "origin/main", ahead: 3, behind: 0 });
  });

  it("handles a detached HEAD and a branch without upstream", () => {
    expect(parseBranch("# branch.oid abc\0# branch.head (detached)\0")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranch("# branch.oid (initial)\0# branch.head main\0")).toEqual({ branch: "main", ahead: 0, behind: 0 });
  });
});
