import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { layoutOf, type Layout } from "../src/tui/layout.js";
import { detailFold, shownFold, stepFold, toggleFold, UNFOLDED, type FoldState } from "../src/tui/listFold.js";
import { App } from "../src/tui/App.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-list-fold-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("list fold", () => {
  it("goes with | to an end and back, to the other end next time", () => {
    const hidden = toggleFold(UNFOLDED);
    expect(shownFold(hidden)).toBe("hidden");
    const back = toggleFold(hidden);
    expect(shownFold(back)).toBeUndefined();
    const full = toggleFold(back);
    expect(shownFold(full)).toBe("full");
    expect(shownFold(toggleFold(toggleFold(full)))).toBe("hidden");
  });

  it("steps with < and > past narrow and wider to the ends, and stops there", () => {
    const down = stepFold(UNFOLDED, "narrow", -1);
    expect(down).toEqual({ state: { fold: "hidden", last: "hidden", drilled: false }, width: "narrow", shown: "hidden" });
    expect(stepFold(down.state, "narrow", -1).shown).toBe("hidden");
    // Out of an end, the width next to it, stored even if another was set.
    expect(stepFold(down.state, "wide", 1)).toEqual({ state: { last: "hidden", drilled: false }, width: "narrow", shown: "narrow" });
    const up = stepFold(UNFOLDED, "wider", 1);
    expect(up.shown).toBe("full");
    expect(stepFold(up.state, "wider", 1).shown).toBe("full");
    expect(stepFold(up.state, "normal", -1)).toMatchObject({ width: "wider", shown: "wider" });
    expect(stepFold(UNFOLDED, "normal", 1)).toEqual({ state: UNFOLDED, width: "wide", shown: "wide" });
  });

  it("lets | go to the other end after < or > reached one", () => {
    const back = stepFold(stepFold(UNFOLDED, "narrow", -1).state, "narrow", 1).state;
    expect(shownFold(toggleFold(back))).toBe("full");
  });

  it("shows a detail opened from the full list over the whole pane, until it closes", () => {
    const full: FoldState = { fold: "full", last: "full", drilled: false };
    const drilled = detailFold(full, true, false);
    expect(shownFold(drilled)).toBe("hidden");
    // Another page of the same detail stays drilled.
    expect(detailFold(drilled, true, true)).toBe(drilled);
    expect(shownFold(detailFold(drilled, false, true))).toBe("full");
    // A detail left open while the list went full stays out of sight.
    expect(shownFold(detailFold(full, true, true))).toBe("full");
    // Not drilled at the set width or folded away.
    expect(detailFold(UNFOLDED, true, false)).toBe(UNFOLDED);
  });

  it("leaves a drilled detail through |, < and > by the usual rules", () => {
    const drilled = detailFold({ fold: "full", last: "full", drilled: false }, true, false);
    const toggled = toggleFold(drilled);
    expect(shownFold(toggled)).toBeUndefined();
    expect(shownFold(toggleFold(toggled))).toBe("full");
    expect(stepFold(drilled, "normal", 1)).toMatchObject({ width: "narrow", shown: "narrow" });
    expect(stepFold(drilled, "normal", -1).shown).toBe("hidden");
  });

  it("gives the preview the pane but the scroll bar's column, or the list the whole pane", () => {
    const set = layoutOf(100, 30, "normal");
    const hidden = layoutOf(100, 30, "normal", "hidden");
    expect(hidden.previewWidth).toBe(99);
    expect(hidden.listWidth).toBe(set.listWidth);
    const full = layoutOf(100, 30, "normal", "full");
    expect(full.listWidth).toBe(100);
    expect(full.previewWidth).toBe(set.previewWidth);
  });
});

describe("| in a view", () => {
  const layout: Layout = { columns: 100, rows: 20, listWidth: 30, previewWidth: 67, bodyHeight: 18 };
  const render = (cwd: string) =>
    renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
  const session = () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-list-fold-app-"));
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
  // A body row of both sides has the border between them.
  const bodyRows = (frame: string) => frame.split("\n").slice(1, -1);
  const split = (frame: string) => bodyRows(frame).every((l) => l.includes("│"));

  it("folds the list away, back, spreads it over the pane and back, without storing it", async () => {
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    expect(split(view.frame())).toBe(true);
    await view.press("|");
    await expect.poll(view.frame).toContain("width: hidden");
    expect(bodyRows(view.frame()).some((l) => l.startsWith("12:00 first question"))).toBe(false);
    expect(view.frame()).toContain("The answer text");
    await view.press("|");
    await expect.poll(view.frame).toContain("width: normal");
    expect(split(view.frame())).toBe(true);
    await view.press("|");
    await expect.poll(view.frame).toContain("width: full");
    expect(view.frame()).not.toContain("The answer text");
    expect(view.frame()).toContain("first question");
    expect(readSettings().chatListWidth).toBe("normal");
    view.unmount();
  });

  it("shows the detail of the full list over the whole pane, and Esc goes back", async () => {
    updateSettings({ chatListWidth: "wider" });
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    await view.press(">");
    await expect.poll(view.frame).toContain("width: full");
    expect(readSettings().chatListWidth).toBe("wider");
    const listed = () => bodyRows(view.frame()).some((l) => l.startsWith("12:00 first question"));
    expect(listed()).toBe(true);
    // Enter: the full prompt, with the preview over the whole pane.
    await view.press("\r");
    await expect.poll(listed).toBe(false);
    expect(view.frame()).toContain("first question");
    await view.press("\u001b");
    await expect.poll(listed).toBe(true);
    // Esc closed the detail and did not ask to quit.
    expect(view.frame()).not.toContain("Quit");
    view.unmount();
  });
});
