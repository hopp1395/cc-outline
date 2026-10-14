import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";

const layout: Layout = { columns: 160, rows: 24, listWidth: 40, previewWidth: 117, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-location-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-location-"));
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("session location", () => {
  it("shows the transcript's file in the header, first of the details", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(projectDir(cwd), "loc1.jsonl"),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: ts, cwd, message: { role: "user", content: "Where am I" } }) + "\n",
    );
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("Transcript"));
    const lines = view.frame().split("\n");
    const at = lines.findIndex((l) => l.includes("Transcript"));
    // First of the details, before the plans; wrapped after a separator, so the file name is whole.
    expect(lines.slice(at, at + 4).join("")).toContain("loc1.jsonl");
    expect(at).toBeLessThan(lines.findIndex((l) => l.includes("Plans (")));
  });
});
