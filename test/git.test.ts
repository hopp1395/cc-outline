import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff.js";
import { fileDiff, listChanges, parseNumstat, parseStatus } from "../src/git/git.js";

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
    const root = mkdtempSync(join(tmpdir(), "cce-git-"));
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
});
