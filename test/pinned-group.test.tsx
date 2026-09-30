import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toggleFavorite } from "../src/favorites.js";
import { updateSettings } from "../src/settings.js";
import type { Turn } from "../src/transcript/parse.js";
import { ChatView } from "../src/tui/ChatView.js";
import type { Layout } from "../src/tui/layout.js";
import type { Transcript } from "../src/tui/useTranscript.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const HOME = "\u001b[H";
const DOWN = "\u001b[B";
const SHIFT_UP = "\u001b[1;2A";

let saved: string | undefined;
let cwd: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-pinned-"));
  cwd = mkdtempSync(join(tmpdir(), "cco-pinned-project-"));
  updateSettings({ pinnedGroup: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

function renderView(element: ReactElement) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const app = render(element, { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

/** The list column's rows below the top bar, top to bottom, without their times and the separators' rules. */
const listLines = (frame: string) =>
  frame
    .split("\n")
    .slice(1, 1 + layout.bodyHeight)
    .map((l) => l.slice(0, 40).replace(/\d\d:\d\d /, "").replace(/─+$/, "").trim())
    .filter(Boolean);

const turn = (id: string, prompt: string): Turn => ({ id, prompt, blocks: [{ kind: "text", text: `Answer ${id}` }], done: true, timestamp: new Date().toISOString() });
const transcript: Transcript = { turns: [turn("a", "first"), turn("b", "second"), turn("c", "third")], plans: [], agents: [], version: 1 };

describe("the Pinned group", () => {
  it("shows the marked turns first, navigates by the rows on screen and hands the selection on when unmarking", async () => {
    toggleFavorite(cwd, "turns", "a");
    toggleFavorite(cwd, "turns", "c");
    const view = renderView(<ChatView cwd={cwd} path="s.jsonl" transcript={transcript} layout={layout} active liveSession />);
    // Following: the newest turn, in the group.
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    expect(listLines(view.frame())).toEqual(["── ★ Pinned", "★ first", "★ third", "── Pinned end", "second"]);
    view.press(DOWN);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer b");
    view.press(SHIFT_UP);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    view.press(HOME);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer a");
    view.press(DOWN);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    // The last pinned row unmarked: the one above takes the selection.
    view.press(" ");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer a");
    expect(listLines(view.frame())).toEqual(["── ★ Pinned", "★ first", "── Pinned end", "second", "third"]);
    // The only one: the selection stays with it, back in its place.
    view.press(" ");
    await expect.poll(() => listLines(view.frame()), { timeout: 2000 }).toEqual(["first", "second", "third"]);
    expect(view.frame()).toContain("Answer a");
    view.unmount();
  });

  it("is off by default", async () => {
    updateSettings({ pinnedGroup: false });
    toggleFavorite(cwd, "turns", "b");
    const view = renderView(<ChatView cwd={cwd} path="s.jsonl" transcript={transcript} layout={layout} active liveSession />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    expect(listLines(view.frame())).toEqual(["first", "★ second", "third"]);
    view.unmount();
  });
});
