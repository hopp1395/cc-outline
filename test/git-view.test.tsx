import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { updateSettings } from "../src/settings.js";
import { GitView } from "../src/tui/GitView.js";
import type { Layout } from "../src/tui/layout.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const DOWN = "\u001b[B";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-git-view-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  updateSettings({ gitNestedRepos: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

/** The list column's rows below the top bar. */
const listLines = (frame: string) =>
  frame
    .split("\n")
    .slice(1, 1 + layout.bodyHeight)
    .map((l) => l.slice(0, 40).trimEnd())
    .filter(Boolean);

describe("Changes with repositories below", () => {
  it("groups the files by repository, with one entry for a clean one and its last commits", async () => {
    const root = mkdtempSync(join(tmpdir(), "cco-git-view-repo-"));
    git(root, "init", "-q");
    writeFileSync(join(root, "a.cs"), "class A {}\n");
    const bar = join(root, "tools", "bar");
    mkdirSync(bar, { recursive: true });
    git(bar, "init", "-q");
    git(bar, "commit", "-q", "--allow-empty", "-m", "first commit");

    const view = renderInk(<GitView cwd={root} layout={layout} active />, layout);
    await expect.poll(view.frame, { timeout: 5000 }).toContain("tools/bar");
    const name = basename(root);
    const lines = listLines(view.frame());
    expect(lines[0]).toMatch(new RegExp(`^── ${name} · \\S+ ─+`));
    expect(lines[1]).toContain("? a.cs +1 -0");
    // The nested repository is no entry of the one around it.
    expect(lines[2]).toMatch(/^── tools\/bar · \S+ ─+/);
    expect(lines).toHaveLength(3);
    expect(view.frame()).toContain("2 repos · 1 files");
    // The separator is selected first: its preview names the change.
    expect(view.frame()).toContain("1 changed file");

    await view.press(DOWN);
    await view.press(DOWN);
    await expect.poll(view.frame).toContain("first commit");
    expect(view.frame()).toContain("No changes");
    expect(view.frame()).toContain("↵ open folder");
    view.unmount();
  });

  it("shows only the repository around the folder with the setting off, under its separator", async () => {
    updateSettings({ gitNestedRepos: false });
    const root = mkdtempSync(join(tmpdir(), "cco-git-view-off-"));
    git(root, "init", "-q");
    mkdirSync(join(root, "sub", ".git"), { recursive: true });
    writeFileSync(join(root, "a.cs"), "class A {}\n");

    const view = renderInk(<GitView cwd={root} layout={layout} active />, layout);
    await expect.poll(view.frame, { timeout: 5000 }).toContain("a.cs");
    expect(listLines(view.frame())[0]).toMatch(new RegExp(`^── ${basename(root)}`));
    expect(view.frame()).not.toContain("repos ·");
    view.unmount();
  });

  it("names the folder when no repository is in or below it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-git-view-none-"));
    const view = renderInk(<GitView cwd={cwd} layout={layout} active />, layout);
    await expect.poll(view.frame, { timeout: 5000 }).toContain("No git repository in");
    view.unmount();
  });
});
