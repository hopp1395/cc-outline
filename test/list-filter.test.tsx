import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick } from "./helpers/ink.js";
import { readSettings } from "../src/settings.js";
import type { Turn } from "../src/transcript/parse.js";
import { App } from "../src/tui/App.js";
import { ChatView } from "../src/tui/ChatView.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView } from "../src/tui/SettingsView.js";
import type { Transcript } from "../src/tui/useTranscript.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-filter-project");
const CTRL_F = "\u0006";
const CTRL_D = "\u0004";
const CTRL_L = "\u000c";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-filter-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout);

/** Waits for a render; keys written at once would reach one handler before the state it set. */

async function type(view: ReturnType<typeof renderView>, text: string) {
  for (const c of text) {
    await view.press(c);
  }
}

describe("list filter in the settings", () => {
  it("filters while typing, keeps the filter with Enter and drops it with Ctrl+F", async () => {
    let typing = false;
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active onTyping={(t) => (typing = t)} />);
    // Below the settings: the four reset actions and the Releases note (no releases known offline).
    const total = SETTING_ROWS.length + 5;
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Filter");
    expect(typing).toBe(true);
    await type(view, "mouse");
    await expect.poll(view.frame, { timeout: 2000 }).toMatch(new RegExp(`\\d+ of ${total}`));
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    // The list's top row shows the filter, the help line no longer offers it.
    expect(view.frame()).toMatch(new RegExp(`⌕  mouse · \\d+ of ${total} · \\^F clear`));
    expect(view.frame()).not.toContain("^F filter");
    expect(typing).toBe(false);
    expect(view.frame()).toMatch(new RegExp(`\\d+/${total} entries`));
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("⌕");
    expect(view.frame()).toContain("^F filter");
    view.unmount();
  });

  it("shows a hint when nothing matches, and Esc in the dialog drops the filter", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "zzzqqq");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("⌕  zzzqqq");
    expect(view.frame()).toContain("No matches");
    await view.press("\u001b");
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    expect(view.frame()).not.toContain("No matches");
    view.unmount();
  });

  it("shows only the separators of groups with a match", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("⌕  wrap");
    const separators = view.frame().match(/── \w+/g);
    expect(separators).toEqual(["── Chat", "── Changes", "── Plan"]);
    view.unmount();
  });

  it("opens with the filter used last, selected, so typing replaces it", async () => {
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    expect(view.frame()).toContain("⌕  wrap");
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("⌕  wrap");
    await view.press(CTRL_F);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("› wrap");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Enter keep");
    expect(view.frame()).toContain("⌕  wrap");
    view.unmount();
  });
});

const turn = (id: string, prompt: string): Turn => ({ id, prompt, blocks: [{ kind: "text", text: `Answer ${id}` }], done: true, timestamp: new Date().toISOString() });
const transcript = (turns: Turn[], version: number): Transcript => ({ turns, plans: [], agents: [], version });

describe("list filter in the chat", () => {
  it("follows only turns that match", async () => {
    const turns = [turn("a", "fix the parser"), turn("b", "add tests"), turn("c", "fix the tail")];
    const chat = (t: Transcript) => <ChatView cwd={cwd} path="s.jsonl" transcript={t} layout={layout} active liveSession />;
    const view = renderView(chat(transcript(turns, 1)));
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    await view.press(CTRL_F);
    await tick();
    await type(view, "fix");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("2/3 turns");
    expect(view.frame()).not.toContain("add tests");
    // A new turn that does not match stays hidden, and the selection stays.
    const more = [...turns, turn("d", "write docs")];
    view.rerender(chat(transcript(more, 2)));
    await expect.poll(view.frame, { timeout: 2000 }).toContain("2/4 turns");
    expect(view.frame()).toContain("Answer c");
    // One that matches is followed.
    view.rerender(chat(transcript([...more, turn("e", "fix it again")], 3)));
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer e");
    expect(view.frame()).toContain("3/5 turns");
    view.unmount();
  });

  it("moves to the nearest match before when the selected turn is filtered out", async () => {
    const turns = [turn("a", "fix the parser"), turn("b", "add tests"), turn("c", "write docs")];
    const view = renderView(<ChatView cwd={cwd} path="s.jsonl" transcript={transcript(turns, 1)} layout={layout} active liveSession />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer c");
    await view.press(CTRL_F);
    await tick();
    await type(view, "te?t");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer b");
    view.unmount();
  });
});

describe("list filter in the app", () => {
  it("keeps the app's keys (q, i, the view numbers) out while typing", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-filter-app-"));
    const view = renderView(<App cwd={project} sessionId="none" initialMode="settings" />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(SETTING_ROWS[0].label);
    await view.press(CTRL_F);
    await tick();
    await type(view, "q1i");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("› q1i");
    // Still the settings, no info dialog, not quit.
    expect(view.frame()).not.toContain("Keys");
    await view.press("\u001b");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("› q1i");
    await view.press("i");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("filter the list");
    view.unmount();
  });
});

describe("where the filter looks", () => {
  it("looks at the rows by default; ^D adds the details and is saved in the settings", async () => {
    const turns: Turn[] = [
      { ...turn("a", "look at this"), attachments: [{ kind: "file", path: "src/parser.ts" }] },
      turn("b", "add tests"),
    ];
    const view = renderView(<ChatView cwd={cwd} path="s.jsonl" transcript={transcript(turns, 1)} layout={layout} active liveSession />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer b");
    await view.press(CTRL_F);
    await tick();
    await type(view, "parser");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("0 of 2");
    expect(view.frame()).toContain("[x] in the list");
    expect(view.frame()).toContain("[ ] in the details");
    await view.press(CTRL_D);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("1 of 2");
    expect(view.frame()).toContain("[x] in the details");
    expect(readSettings().filterIn).toBe("both");
    await view.press(CTRL_L);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("[ ] in the list");
    expect(readSettings().filterIn).toBe("details");
    view.unmount();
  });
});
