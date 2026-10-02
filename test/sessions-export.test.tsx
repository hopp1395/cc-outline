import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readExportOptions } from "../src/export/archive.js";
import { readZip } from "../src/export/zip.js";
import { toggleFavorite } from "../src/favorites.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const cwd = join(tmpdir(), "cco-sessions-export-project");

let saved: Record<string, string | undefined> = {};
let out: string;
beforeEach(() => {
  saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CCO_EXPORT_DIR: process.env.CCO_EXPORT_DIR };
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-sessions-export-"));
  out = mkdtempSync(join(tmpdir(), "cco-sessions-export-out-"));
  process.env.CCO_EXPORT_DIR = out;
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function renderView() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  const frames: string[] = [];
  stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (stripAnsi(text).trim()) frames.push(text);
  });
  const app = render(<SessionsView cwd={cwd} layout={layout} visible active />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  return { frame: () => stripAnsi(frames.at(-1) ?? ""), press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await tick();
}

function session(id: string, text: string, minutesAgo: number) {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  writeFileSync(
    join(projectDir(cwd), `${id}.jsonl`),
    JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } }) + "\n",
  );
}

const folders = (file: string) => [...new Set(readZip(file).map((e) => e.name.split("/")[0]!))];

describe("export in the Sessions view", () => {
  it("exports the selected session with the options chosen in the form, and remembers them", async () => {
    session("aaaaaaaa-1", "first question", 10);
    session("bbbbbbbb-2", "second question", 5);
    const view = renderView();
    await until(() => view.frame().includes("second question"));
    view.press("e");
    await until(() => view.frame().includes("Tool calls"));
    expect(view.frame()).toContain("markdown · llm · json · backup");
    expect(view.frame()).toContain("cco-session-export.zip");
    // Turn stats off: ↑ wraps to the last field, ← changes it.
    view.press("\u001b[A");
    await tick();
    view.press("\u001b[D");
    await tick();
    view.press("\r");
    await until(() => view.frame().includes("Export done"));
    expect(view.frame()).toContain("exported 1 session");
    expect(view.frame()).toContain("cco-session-export.zip");
    expect(readExportOptions().stats).toBe(false);
    const file = join(out, "cco-session-export.zip");
    expect(folders(file).map((f) => f.replace(/^\d{4}-\d\d-\d\d-\d{4}-/, ""))).toEqual(["bbbbbbbb-markdown", "bbbbbbbb-llm", "bbbbbbbb-json", "bbbbbbbb-backup"]);
    view.press("\u001b");
    await until(() => !view.frame().includes("Export done"));
    view.unmount();
  });

  it("exports all marked sessions, and imports them back with I", async () => {
    session("aaaaaaaa-1", "first question", 10);
    session("bbbbbbbb-2", "second question", 5);
    session("cccccccc-3", "third question", 1);
    toggleFavorite(cwd, "sessions", "aaaaaaaa-1");
    toggleFavorite(cwd, "sessions", "bbbbbbbb-2");
    const view = renderView();
    await until(() => view.frame().includes("third question"));
    view.press("e");
    await until(() => view.frame().includes("2 marked sessions"));
    view.press("\r");
    await until(() => view.frame().includes("Export done"));
    const file = join(out, "cco-session-export.zip");
    expect(folders(file).filter((f) => f.endsWith("-backup")).map((f) => f.slice(16, 24))).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    view.press("\u001b");
    await until(() => !view.frame().includes("Export done"));

    rmSync(join(projectDir(cwd), "aaaaaaaa-1.jsonl"));
    view.press("I");
    await until(() => view.frame().includes("Import sessions"));
    expect(view.frame()).toContain("cco-session-export.zip");
    view.press("\r");
    await until(() => view.frame().includes("Import done"));
    expect(view.frame()).toContain("imported 1 session · skipped 1 (already there)");
    view.unmount();
    expect(claudeDir()).toBeTruthy();
  });
});
