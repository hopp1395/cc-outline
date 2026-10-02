import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Text } from "ink";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick } from "./helpers/ink.js";
import { readSettings, settingsFile } from "../src/settings.js";
import { TIMING } from "../src/timing.js";
import { App } from "../src/tui/App.js";
import { isF5, isReloadKey, useReloadKey } from "../src/tui/reload.js";
import { transcriptForSession } from "../src/transcript/locate.js";
import { useTranscript } from "../src/tui/useTranscript.js";

const F5 = "\u001b[15~";
const CTRL_R = "\u0012";
const UP = "\u001b[A";
const CTRL_F = "\u0006";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const prompt = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
const answer = (uuid: string, text: string) =>
  line({ type: "assistant", uuid, message: { id: `m-${uuid}`, content: [{ type: "text", text }], stop_reason: "end_turn" } });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-reload-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, { columns: 220, rows: 24 });


describe("reload keys", () => {
  it("knows F5 as terminals send it, without modifiers", () => {
    expect(isF5("\u001b[15~")).toBe(true);
    expect(isF5("\u001b[[E")).toBe(true);
    expect(isF5("\u001b[15;2~")).toBe(false);
    expect(isF5("\u001b[17~")).toBe(false);
  });

  it("takes Ctrl+R, not a plain r", () => {
    const key = (ctrl: boolean) => ({ ctrl }) as Parameters<typeof isReloadKey>[1];
    expect(isReloadKey("r", key(true))).toBe(true);
    expect(isReloadKey("r", key(false))).toBe(false);
  });

  it("calls back on F5 and Ctrl+R while active", async () => {
    let count = 0;
    function Probe({ active }: { active: boolean }) {
      useReloadKey(() => count++, active);
      return <Text>probe</Text>;
    }
    const view = renderView(<Probe active />);
    await expect.poll(view.frame).toContain("probe");
    await view.press(F5);
    await tick();
    await view.press(CTRL_R);
    await tick();
    await view.press("\u001b[17~");
    await tick();
    expect(count).toBe(2);
    view.rerender(<Probe active={false} />);
    await tick();
    await view.press(F5);
    await tick();
    expect(count).toBe(2);
    view.unmount();
  });
});

describe("useTranscript reload", () => {
  it("reads the transcript again with a new parser, which a tail would miss", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cco-reload-t-")), "s.jsonl");
    writeFileSync(path, prompt("a", "fix it") + answer("r", "Done."));
    function Probe({ reload }: { reload: number }) {
      const t = useTranscript(path, reload);
      const turns = t.turns.map((turn) => `${turn.prompt}=${turn.blocks.map((b) => (b.kind === "text" ? b.text : b.kind)).join("+")}`);
      return <Text>{`${turns.join("|")}#${t.loaded ?? "-"}`}</Text>;
    }
    const view = renderView(<Probe reload={0} />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("fix it=Done.#-");
    // Same size, other text: the tail sees nothing new.
    writeFileSync(path, prompt("a", "fix it") + answer("r", "Fine."));
    await new Promise((resolve) => setTimeout(resolve, 3 * TIMING.tailStat));
    expect(view.frame()).toContain("fix it=Done.");
    view.rerender(<Probe reload={1} />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("fix it=Fine.#1");
    view.unmount();
  });
});

describe("reload in the app", () => {
  it("reads settings.json again, drops the filter and says so in the top bar", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-reload-app-"));
    const view = renderView(<App cwd={project} sessionId="none" initialMode="settings" />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("settings.json");
    expect(view.frame()).not.toContain("changed");
    await view.press(CTRL_F);
    await tick();
    await view.press("zzz");
    await tick();
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("0 of");
    // The dialog closed: the app takes keys again.
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("in the list");
    // Another viewer changes a setting.
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), confirmQuit: !readSettings().confirmQuit }));
    await tick();
    await view.press(F5);
    await expect.poll(view.frame, { timeout: 3000, interval: 20 }).toContain("reloaded");
    expect(view.frame()).toContain("1 changed");
    expect(view.frame()).not.toContain("0 of");
    await expect.poll(view.frame, { timeout: 3000 }).not.toContain("reloaded");
    view.unmount();
  });

  it("reads the chat's transcript again, keeping the selected turn", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-reload-app-"));
    const path = transcriptForSession(project, "s1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prompt("a", "first question") + answer("r", "Answer one.") + prompt("b", "second question") + answer("s", "Answer two."));
    const view = renderView(<App cwd={project} sessionId="s1" initialMode="chat" />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer two.");
    await view.press(UP);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Answer one.");
    // Same size, other text: only a reload sees it.
    writeFileSync(path, prompt("a", "first question") + answer("r", "Answer 111.") + prompt("b", "second question") + answer("s", "Answer two."));
    await tick();
    await view.press(CTRL_R);
    await expect.poll(view.frame, { timeout: 3000, interval: 20 }).toContain("reloaded");
    expect(view.frame()).toContain("Answer 111.");
    view.unmount();
  });

  it("ignores F5 while a dialog is open", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-reload-app-"));
    const view = renderView(<App cwd={project} sessionId="none" initialMode="settings" />);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("settings.json");
    await view.press("i");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("reload this view");
    await view.press(F5);
    await tick();
    await tick();
    expect(view.frame()).not.toContain("reload…");
    expect(view.frame()).not.toContain("reloaded");
    view.unmount();
  });
});
