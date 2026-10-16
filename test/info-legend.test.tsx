import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { App } from "../src/tui/App.js";
import { legendLines, LEGENDS } from "../src/tui/legend.js";
import type { Mode } from "../src/tui/layout.js";

const RIGHT = "\u001b[C";
const plain = (l: string) => l.replace(/\u001b\[[0-9;]*m/g, "");
const MODES: Mode[] = ["chat", "git", "plan", "sessions", "monitor", "accounts", "settings"];

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-info-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("the legends", () => {
  it("has marks for every view, each marked entry among them, two to a line of the dialog", () => {
    for (const mode of MODES) {
      expect(LEGENDS[mode].length, mode).toBeGreaterThan(2);
      expect(LEGENDS[mode].some((m) => m.mark === "★"), mode).toBe(true);
      for (const line of legendLines(LEGENDS[mode], 74)) expect(stringWidth(plain(line)), mode).toBeLessThanOrEqual(74);
      expect(legendLines(LEGENDS[mode], 74).length, mode).toBe(Math.ceil(LEGENDS[mode].length / 2));
    }
  });

  it("shows the view's legend on the second page and no marks among the Sessions keys", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-info-app-"));
    const view = renderInk(<App cwd={project} sessionId="none" initialMode="sessions" />, { columns: 120, rows: 40 });
    await view.press("i");
    await expect.poll(view.frame).toContain("Keys · Sessions");
    expect(view.frame()).not.toContain("folder gone");
    await view.press(RIGHT);
    await expect.poll(view.frame).toContain("Legend · Sessions");
    expect(view.frame()).toContain("folder gone");
    view.unmount();
  });

  it("opens on the keys and switches pages with → and Tab", async () => {
    const project = mkdtempSync(join(tmpdir(), "cco-info-app-"));
    const view = renderInk(<App cwd={project} sessionId="none" initialMode="plan" />, { columns: 120, rows: 40 });
    await view.press("i");
    await expect.poll(view.frame).toContain("Keys · Plan");
    await view.press(RIGHT);
    await expect.poll(view.frame).toContain("Legend · Plan");
    expect(view.frame()).toContain("waits for approval");
    await view.press("\t");
    await expect.poll(view.frame).toContain("Keys · Plan");
    await view.press(RIGHT);
    await expect.poll(view.frame).toContain("Legend · Plan");
    // Closed and opened again, it starts on the keys.
    await view.press("i");
    await expect.poll(view.frame).not.toContain("Legend · Plan");
    await view.press("i");
    await expect.poll(view.frame).toContain("Keys · Plan");
    view.unmount();
  });
});
