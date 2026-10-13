import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { type Layout } from "../src/tui/layout.js";
import { App } from "../src/tui/App.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-compact-app-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("compact view in the app", () => {
  const layout: Layout = { columns: 60, rows: 20, listWidth: 20, previewWidth: 37, bodyHeight: 18 };
  const render = (cwd: string) =>
    renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
  const session = () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-compact-app-cwd-"));
    const folder = join(process.env.CLAUDE_CONFIG_DIR!, "projects", projectSlug(cwd));
    mkdirSync(folder, { recursive: true });
    const lines = [
      { type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-10-02T10:00:00.000Z", message: { role: "user", content: "first question" } },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "s1",
        timestamp: "2026-10-02T10:00:05.000Z",
        message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "The answer text" }] },
      },
    ];
    writeFileSync(join(folder, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return cwd;
  };

  const listed = (frame: string) => frame.split("\n").some((l) => /^\d\d:\d\d first question/.test(l));

  it("single: | swaps the list and the preview, < and > change nothing", async () => {
    updateSettings({ compactView: "single" });
    const view = render(session());
    await expect.poll(() => listed(view.frame())).toBe(true);
    expect(view.frame()).not.toContain("The answer text");
    await view.press(">");
    expect(readSettings().chatListWidth).toBe("normal");
    await view.press("|");
    await expect.poll(view.frame).toContain("The answer text");
    expect(listed(view.frame())).toBe(false);
    await view.press("|");
    await expect.poll(() => listed(view.frame())).toBe(true);
    view.unmount();
  });

  it("stacked: list and preview together, > and < set the list's columns, stopping at the ends", async () => {
    updateSettings({ compactView: "stacked" });
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    expect(view.frame()).toContain("first question");
    await view.press(">");
    await expect.poll(view.frame).toContain("columns: 2");
    expect(readSettings().compactColumns).toBe("2");
    await view.press(">");
    await view.press(">");
    await view.press(">");
    expect(readSettings().compactColumns).toBe("4");
    await view.press("<");
    await expect.poll(() => readSettings().compactColumns).toBe("3");
    await view.press("|");
    expect(view.frame()).toContain("The answer text");
    view.unmount();
  });
});
