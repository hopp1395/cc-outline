import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayKey } from "../src/monitor/responses.js";
import { projectDir } from "../src/transcript/locate.js";
import { dayLabel } from "../src/tui/days.js";
import type { Layout } from "../src/tui/layout.js";
import { MonitorView } from "../src/tui/MonitorView.js";
import { SessionsView } from "../src/tui/SessionsView.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-range-project");
const DAY = 86_400_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-range-"));
  mkdirSync(projectDir(cwd), { recursive: true });
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

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
}

/** A transcript with one prompt and one answer at `at`, last written then. */
function session(id: string, text: string, at: number) {
  const ts = new Date(at).toISOString();
  const path = join(projectDir(cwd), `${id}.jsonl`);
  writeFileSync(
    path,
    [
      { type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } },
      {
        type: "assistant",
        uuid: `${id}-a`,
        timestamp: new Date(at + 5000).toISOString(),
        message: { id: `${id}-m`, model: "claude-opus-5-5", role: "assistant", usage: { output_tokens: 400 }, content: [{ type: "text", text: "ok" }] },
      },
    ]
      .map((e) => JSON.stringify(e) + "\n")
      .join(""),
  );
  utimesSync(path, new Date(at + 5000), new Date(at + 5000));
}

describe("list range", () => {
  it("lists the sessions of the range newest first and loads the rest with load more", async () => {
    session("recent", "Recent work", Date.now() - 2 * DAY);
    session("today", "Work of today", Date.now() - 60_000);
    session("old", "Old work", Date.now() - 60 * DAY);
    const view = renderView(<SessionsView cwd={cwd} layout={layout} visible active />);
    await until(() => view.frame().includes("more ↓"));
    const frame = view.frame();
    expect(frame).not.toContain("Old work");
    expect(frame.indexOf("Work of today")).toBeLessThan(frame.indexOf("Recent work"));
    expect(frame.indexOf("Recent work")).toBeLessThan(frame.indexOf("more ↓"));

    view.press("\u001b[F"); // End: the last entry, load more
    await until(() => view.frame().includes("loads the whole history"));
    view.press("\r");
    await until(() => view.frame().includes("Old work"));
    expect(view.frame()).not.toContain("more ↓");
    // The selection goes to the newest of the sessions read now, where load more was.
    await until(() => view.frame().includes("claude --resume old"));
    expect(view.frame()).toContain("claude --resume old");
    view.unmount();
  });

  it("lists a session started before the range but asked again in it", async () => {
    session("old", "Old work", Date.now() - 60 * DAY);
    const path = join(projectDir(cwd), "resumed.jsonl");
    const ask = (uuid: string, text: string, at: number) =>
      JSON.stringify({ type: "user", uuid, timestamp: new Date(at).toISOString(), cwd, message: { role: "user", content: text } }) + "\n";
    writeFileSync(path, ask("r1", "Started long ago", Date.now() - 60 * DAY) + ask("r2", "Resumed today", Date.now() - 60_000));
    const view = renderView(<SessionsView cwd={cwd} layout={layout} visible active />);
    await until(() => view.frame().includes("more ↓"));
    expect(view.frame()).toContain("Started long ago");
    expect(view.frame()).not.toContain("Old work");
    view.unmount();
  });

  it("keeps load more at the end of a filtered list", async () => {
    session("today", "Work of today", Date.now() - 60_000);
    const view = renderView(<SessionsView cwd={cwd} layout={layout} visible active />);
    await until(() => view.frame().includes("more ↓"));
    view.press("\u0006");
    await tick();
    for (const c of "nothing") {
      view.press(c);
      await tick();
    }
    view.press("\r");
    await until(() => view.frame().includes("0 of 1"));
    expect(view.frame()).toContain("more ↓");
    view.unmount();
  });

  it("lists the days of the range and loads the rest with load more", async () => {
    session("today", "Work of today", Date.now() - 60_000);
    session("old", "Old work", Date.now() - 60 * DAY);
    const view = renderView(<MonitorView cwd={cwd} layout={layout} visible active />);
    await until(() => view.frame().includes("more ↓"));
    expect(view.frame()).toContain("1 responses");
    view.press("\u001b[F");
    await tick();
    view.press("\r");
    await until(() => view.frame().includes("2 responses"));
    expect(view.frame()).not.toContain("more ↓");
    expect(view.frame()).toContain(`${dayLabel(dayKey(Date.now() - 60 * DAY))} · Overall`);
    view.unmount();
  });
});
