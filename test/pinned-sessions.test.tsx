import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { toggleFavorite } from "../src/favorites.js";
import { updateSettings } from "../src/settings.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { afterLeaving } from "../src/tui/useListFilter.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const SHIFT_UP = "\u001b[1;2A";

let saved: string | undefined;
let cwd: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-pinned-sessions-"));
  cwd = mkdtempSync(join(tmpdir(), "cco-pinned-sessions-project-"));
  mkdirSync(projectDir(cwd), { recursive: true });
  updateSettings({ allProjects: false });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = () => renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);

/** A session whose prompt was `minutes` ago. */
function session(id: string, text: string, minutes: number) {
  const ts = new Date(Date.now() - minutes * 60_000).toISOString();
  writeFileSync(
    join(projectDir(cwd), `${id}.jsonl`),
    JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } }) + "\n",
  );
}

/** Registers the session as run by this process; undefined: none runs. */
function running(id: string | undefined) {
  const file = join(claudeDir(), "sessions", `${process.pid}.json`);
  if (!id) return rmSync(file, { force: true });
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: id, status: "idle" }));
}

/** The list column's rows below the top bar, top to bottom, without times, rules and the selection's arrow. */
const listLines = (frame: string) =>
  frame
    .split("\n")
    .slice(1, 1 + layout.bodyHeight)
    .map((l) =>
      l
        .slice(0, 40)
        .replace(/\d\d:\d\d/, "")
        .replace(/─+|[„“]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

/** The prompt the preview shows (its header names the session's prompt). */
const previewShows = (frame: string, text: string) => frame.split("\n").some((l) => l.slice(41).includes(text));

describe("pinned sessions", () => {
  it("pins the running session, also with pinned favorites off, and mixes it with the marked ones in list order", async () => {
    session("s1", "oldest work", 30);
    session("s2", "middle work", 20);
    session("s3", "newest work", 10);
    running("s1");
    const view = renderView();
    await until(() => listLines(view.frame()).some((l) => l.includes("Pinned")));
    expect(listLines(view.frame()).slice(0, 2)).toEqual(["★ Pinned", "▶ oldest work"]);
    expect(listLines(view.frame()).filter((l) => l.includes("oldest work"))).toEqual(["▶ oldest work", "▶ oldest work"]);

    updateSettings({ pinnedFavorites: true });
    toggleFavorite(cwd, "sessions", "s2");
    view.unmount();
    const again = renderView();
    await until(() => listLines(again.frame()).includes("★ middle work"));
    expect(listLines(again.frame()).slice(0, 3)).toEqual(["★ Pinned", "★ middle work", "▶ oldest work"]);
    again.unmount();
  });

  it("is a setting", async () => {
    updateSettings({ pinnedSessions: false });
    session("s1", "oldest work", 30);
    session("s2", "newest work", 10);
    running("s1");
    const view = renderView();
    await until(() => listLines(view.frame()).includes("▶ oldest work"));
    expect(listLines(view.frame()).some((l) => l.includes("Pinned"))).toBe(false);
    view.unmount();
  });

  it("hands the selection on when a selected pinned session ends", async () => {
    updateSettings({ pinnedFavorites: true });
    session("s1", "oldest work", 30);
    session("s2", "middle work", 20);
    session("s3", "newest work", 10);
    toggleFavorite(cwd, "sessions", "s1");
    running("s2");
    const view = renderView();
    await until(() => listLines(view.frame()).includes("▶ middle work"));
    expect(listLines(view.frame()).slice(0, 3)).toEqual(["★ Pinned", "▶ middle work", "★ oldest work"]);
    // From the newest session in the list: Shift+↑ the group's last row, again its first (the running one, unmarked).
    await view.press(SHIFT_UP);
    await view.press(SHIFT_UP);
    await until(() => previewShows(view.frame(), "middle work"));
    running(undefined);
    // It leaves the group; the pinned row below it takes the selection.
    await until(() => !listLines(view.frame()).includes("▶ middle work"));
    await until(() => previewShows(view.frame(), "oldest work"));
    expect(listLines(view.frame()).slice(0, 2)).toEqual(["★ Pinned", "★ oldest work"]);
    view.unmount();
  });
});

describe("afterLeaving", () => {
  it("picks the next entry still in the group, else the one above", () => {
    expect(afterLeaving([4, 2, 7], [4, 7], 2)).toBe(7);
    expect(afterLeaving([4, 2, 7], [4, 2], 7)).toBe(2);
    expect(afterLeaving([4, 2, 7], [4], 2)).toBe(4);
    expect(afterLeaving([2], [], 2)).toBeUndefined();
    expect(afterLeaving([4], [4], 2)).toBeUndefined();
  });
});
