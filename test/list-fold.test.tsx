import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { layoutOf, type Layout } from "../src/tui/layout.js";
import { detailFold, shownFold, stepFold, toggleFold, UNFOLDED } from "../src/tui/listFold.js";
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
  it("goes with | to an end and back to the width before, to the other end next time", () => {
    const hidden = toggleFold("wide", UNFOLDED, "wide");
    expect(hidden.width).toBe("hidden");
    const back = toggleFold(hidden.width, hidden.state, "wide");
    expect(back.width).toBe("wide");
    const full = toggleFold(back.width, back.state, "wide");
    expect(full.width).toBe("full");
    expect(toggleFold(full.width, full.state, "wide").width).toBe("wide");
  });

  it("goes with | from an end to the width next to it when the one before is not known", () => {
    expect(toggleFold("hidden", UNFOLDED).width).toBe("narrow");
    expect(toggleFold("full", UNFOLDED).width).toBe("wider");
    // After a restart, the first | from a width folds the list away.
    expect(toggleFold("normal", UNFOLDED).width).toBe("hidden");
  });

  it("steps with < and > past narrow and wider to the ends, and stops there", () => {
    const down = stepFold("narrow", UNFOLDED, -1);
    expect(down).toEqual({ width: "hidden", state: { last: "hidden", drilled: false } });
    expect(stepFold("hidden", down.state, -1).width).toBe("hidden");
    expect(stepFold("hidden", down.state, 1).width).toBe("narrow");
    expect(stepFold("wider", UNFOLDED, 1).width).toBe("full");
    expect(stepFold("full", UNFOLDED, 1).width).toBe("full");
    expect(stepFold("full", UNFOLDED, -1).width).toBe("wider");
    expect(stepFold("normal", UNFOLDED, 1)).toEqual({ width: "wide", state: UNFOLDED });
  });

  it("lets | go to the other end after < or > reached one", () => {
    const down = stepFold("narrow", UNFOLDED, -1);
    const back = stepFold(down.width, down.state, 1);
    expect(toggleFold(back.width, back.state, "narrow").width).toBe("full");
  });

  it("shows a detail opened from the full list over the whole pane, until it closes", () => {
    const drilled = detailFold("full", UNFOLDED, true, false);
    expect(shownFold("full", drilled)).toBe("hidden");
    // Another page of the same detail stays drilled.
    expect(detailFold("full", drilled, true, true)).toBe(drilled);
    expect(shownFold("full", detailFold("full", drilled, false, true))).toBe("full");
    // A detail left open while the list went full stays out of sight.
    expect(detailFold("full", UNFOLDED, true, true)).toBe(UNFOLDED);
    // Not drilled at a width or folded away.
    expect(detailFold("normal", UNFOLDED, true, false)).toBe(UNFOLDED);
    expect(detailFold("hidden", UNFOLDED, true, false)).toBe(UNFOLDED);
  });

  it("leaves a drilled detail through |, < and > by the usual rules", () => {
    const drilled = detailFold("full", UNFOLDED, true, false);
    const toggled = toggleFold("full", drilled, "normal");
    expect(toggled.width).toBe("normal");
    expect(toggleFold(toggled.width, toggled.state, "normal").width).toBe("full");
    expect(stepFold("full", drilled, 1)).toMatchObject({ width: "narrow", state: { drilled: false } });
    expect(stepFold("full", drilled, -1)).toMatchObject({ width: "hidden", state: { drilled: false } });
  });

  it("gives the preview the pane but the scroll bar's column, or the list the whole pane", () => {
    const set = layoutOf(100, 30, "normal");
    const hidden = layoutOf(100, 30, "hidden");
    expect(hidden.fold).toBe("hidden");
    expect(hidden.previewWidth).toBe(99);
    const full = layoutOf(100, 30, "full");
    expect(full.fold).toBe("full");
    expect(full.listWidth).toBe(100);
    expect(full.previewWidth).toBe(set.previewWidth);
    expect(layoutOf(100, 30, "full", true)).toMatchObject({ fold: "hidden", previewWidth: 99 });
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

  it("folds the list away, back, spreads it over the pane and back, storing each", async () => {
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    expect(split(view.frame())).toBe(true);
    await view.press("|");
    await expect.poll(view.frame).toContain("width: hidden");
    expect(bodyRows(view.frame()).some((l) => /^\d\d:\d\d first question/.test(l))).toBe(false);
    expect(view.frame()).toContain("The answer text");
    await view.press("|");
    await expect.poll(view.frame).toContain("width: normal");
    expect(split(view.frame())).toBe(true);
    await view.press("|");
    await expect.poll(view.frame).toContain("width: full");
    expect(view.frame()).not.toContain("The answer text");
    expect(view.frame()).toContain("first question");
    expect(readSettings().chatListWidth).toBe("full");
    view.unmount();
  });

  it("shows the detail of the full list over the whole pane, and Esc goes back", async () => {
    updateSettings({ chatListWidth: "wider" });
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    await view.press(">");
    await expect.poll(view.frame).toContain("width: full");
    expect(readSettings().chatListWidth).toBe("full");
    const listed = () => bodyRows(view.frame()).some((l) => /^\d\d:\d\d first question/.test(l));
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

  it("starts folded away as stored, and | goes to the width next to it", async () => {
    updateSettings({ chatListWidth: "hidden" });
    const view = render(session());
    await expect.poll(view.frame).toContain("The answer text");
    expect(split(view.frame())).toBe(false);
    await view.press("|");
    await expect.poll(view.frame).toContain("width: narrow");
    expect(readSettings().chatListWidth).toBe("narrow");
    view.unmount();
  });
});
