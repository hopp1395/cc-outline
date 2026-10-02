import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { DEFAULT_SETTINGS, readSettings, settingsFile, stepListWidth, updateSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { layoutOf, listColumns, type Layout } from "../src/tui/layout.js";
import { App } from "../src/tui/App.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-list-width-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("list width", () => {
  it("keeps the normal width as before", () => {
    for (const columns of [40, 60, 100, 140, 200]) {
      expect(listColumns(columns, "normal")).toBe(Math.min(40, Math.max(20, Math.floor(columns * 0.3))));
    }
  });

  it("takes each step's share within its limits", () => {
    expect(listColumns(100, "narrow")).toBe(20);
    expect(listColumns(100, "wide")).toBe(40);
    expect(listColumns(100, "wider")).toBe(50);
    expect(listColumns(200, "wider")).toBe(80);
    expect(listColumns(60, "narrow")).toBe(16);
  });

  it("leaves the preview 20 columns, but never goes below the normal width", () => {
    expect(listColumns(50, "wider")).toBe(27);
    expect(listColumns(40, "wider")).toBe(listColumns(40, "normal"));
    const layout = layoutOf(80, 30, "wider");
    expect(layout.listWidth + 3 + layout.previewWidth).toBe(80);
  });

  it("steps narrower and wider, stopping at the ends", () => {
    expect(stepListWidth("normal", 1)).toBe("wide");
    expect(stepListWidth("wider", 1)).toBe("wider");
    expect(stepListWidth("normal", -1)).toBe("narrow");
    expect(stepListWidth("narrow", -1)).toBe("narrow");
  });

  it("falls back to normal for an unknown value", () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ chatListWidth: "huge", gitListWidth: "wide" }));
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, gitListWidth: "wide" });
  });
});

describe("< and > in a view", () => {
  const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };

  it("store the shown view's width and say it for a moment", async () => {
    const view = renderInk(<App cwd={mkdtempSync(join(tmpdir(), "cco-list-width-app-"))} initialMode="settings" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("settings.json");
    await view.press(">");
    await expect.poll(view.frame).toContain("width: wide");
    expect(readSettings().settingsListWidth).toBe("wide");
    await view.press(">");
    await view.press(">");
    await expect.poll(() => readSettings().settingsListWidth).toBe("wider");
    await expect.poll(view.frame).toContain("width: wider");
    await view.press("<");
    await expect.poll(() => readSettings().settingsListWidth).toBe("wide");
    // The other views keep theirs.
    expect(readSettings().chatListWidth).toBe("normal");
    view.unmount();
  });

  it("say it also over a plain message, e.g. Plan without plans", async () => {
    const view = renderInk(<App cwd={mkdtempSync(join(tmpdir(), "cco-list-width-app-"))} sessionId="none" initialMode="plan" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("No plans yet");
    await view.press(">");
    await expect.poll(view.frame).toContain("width: wide");
    expect(readSettings().planListWidth).toBe("wide");
    view.unmount();
  });

  it("keep the list's width next to a long plain message (Plan in a session without plans)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-list-width-app-"));
    const folder = join(process.env.CLAUDE_CONFIG_DIR!, "projects", projectSlug(cwd));
    mkdirSync(folder, { recursive: true });
    const prompt = { type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-10-02T10:00:00.000Z", message: { role: "user", content: "hello" } };
    writeFileSync(join(folder, "s1.jsonl"), JSON.stringify(prompt) + "\n");
    updateSettings({ planListWidth: "wide" });
    const view = renderInk(<App cwd={cwd} sessionId="s1" initialMode="plan" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await expect.poll(view.frame).toContain("No plan in this session yet");
    const row = view.frame().split("\n").find((l) => l.startsWith("No plans yet"))!;
    expect(row.indexOf("│")).toBe(listColumns(layout.columns, "wide"));
    view.unmount();
  });
});
