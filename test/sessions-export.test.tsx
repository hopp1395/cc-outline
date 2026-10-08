import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick, until } from "./helpers/ink.js";
import { readExportOptions } from "../src/export/archive.js";
import { readZip } from "../src/export/zip.js";
import { toggleFavorite } from "../src/favorites.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

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

const renderView = () => renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });


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
    await view.press("\r");
    await until(() => view.frame().includes("Export it"));
    await view.press("4");
    await until(() => view.frame().includes("Tool calls"));
    expect(view.frame()).toContain("markdown · llm · json · backup");
    expect(view.frame()).toContain("cco-session-export.zip");
    // Turn stats off: ↑ wraps to the last field, ← changes it.
    await view.press("\u001b[A");
    await tick();
    await view.press("\u001b[D");
    await tick();
    await view.press("\r");
    await until(() => view.frame().includes("✓ Exported"));
    expect(view.frame()).toContain("Export 1 session");
    expect(view.frame()).toContain("Exported 1 session");
    expect(view.frame()).toContain("cco-session-export.zip");
    expect(readExportOptions().stats).toBe(false);
    const file = join(out, "cco-session-export.zip");
    expect(folders(file).map((f) => f.replace(/^\d{4}-\d\d-\d\d-\d{4}-/, ""))).toEqual(["bbbbbbbb-markdown", "bbbbbbbb-llm", "bbbbbbbb-json", "bbbbbbbb-backup"]);
    await view.press("\u001b");
    await until(() => !view.frame().includes("✓ Exported"));
    view.unmount();
  });

  it("exports all marked sessions, and imports them back through the dialog", async () => {
    session("aaaaaaaa-1", "first question", 10);
    session("bbbbbbbb-2", "second question", 5);
    session("cccccccc-3", "third question", 1);
    toggleFavorite(cwd, "sessions", "aaaaaaaa-1");
    toggleFavorite(cwd, "sessions", "bbbbbbbb-2");
    const view = renderView();
    await until(() => view.frame().includes("third question"));
    await view.press("\r");
    await until(() => view.frame().includes("Export 2 marked sessions"));
    await view.press("4");
    await until(() => view.frame().includes("Tool calls"));
    expect(view.frame()).toContain("2 marked sessions");
    await view.press("\r");
    await until(() => view.frame().includes("✓ Exported"));
    const file = join(out, "cco-session-export.zip");
    expect(folders(file).filter((f) => f.endsWith("-backup")).map((f) => f.slice(16, 24))).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    await view.press("\u001b");
    await until(() => !view.frame().includes("✓ Exported"));
    // The view takes keys again once the dialog has closed: let its effects run first (slow CI runners).
    await tick(100);

    rmSync(join(projectDir(cwd), "aaaaaaaa-1.jsonl"));
    await view.press("\r");
    await until(() => view.frame().includes("Import sessions…"));
    await view.press("5");
    await until(() => view.frame().includes("Sessions that are there already"));
    expect(view.frame()).toContain("cco-session-export.zip");
    await view.press("\r");
    await until(() => view.frame().includes("✓ Imported"));
    expect(view.frame()).toContain("Imported 1 session · skipped 1 (already there)");
    view.unmount();
    expect(claudeDir()).toBeTruthy();
  }, 15_000);

  it("offers to import from an empty list", async () => {
    const view = renderView();
    await until(() => view.frame().includes("import sessions…"));
    expect(view.frame()).toContain("↵ import");
    await view.press("\r");
    await until(() => view.frame().includes("Sessions that are there already"));
    await view.press("\u001b");
    await until(() => !view.frame().includes("Sessions that are there already"));
    view.unmount();
  });

  it("marks a session whose folder is gone and moves it here", async () => {
    const gone = join(tmpdir(), "cco-sessions-export-gone");
    mkdirSync(projectDir(gone), { recursive: true });
    writeFileSync(
      join(projectDir(gone), "dddddddd-4.jsonl"),
      JSON.stringify({ type: "user", uuid: "d-u", timestamp: new Date().toISOString(), cwd: gone, message: { role: "user", content: "orphaned question" } }) + "\n",
    );
    mkdirSync(cwd, { recursive: true });
    const view = renderView();
    await until(() => view.frame().includes("orphaned question"));
    expect(view.frame()).toContain("∅");
    expect(view.frame()).toContain("folder gone");
    await view.press("\r");
    await until(() => view.frame().includes("Move it here"));
    await view.press("\r");
    await until(() => view.frame().includes("Move this session here?"));
    await view.press("\r");
    await until(() => view.frame().includes("moved here"));
    expect(existsSync(join(projectDir(cwd), "dddddddd-4.jsonl"))).toBe(true);
    expect(existsSync(projectDir(gone))).toBe(false);
    view.unmount();
  });
});
