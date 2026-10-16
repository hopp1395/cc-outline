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

describe("session attachments", () => {
  it("lists a session's attachments after its plans, counts them in the row and opens the dialog with o", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    writeFileSync(
      join(projectDir(cwd), "att1.jsonl"),
      [
        { type: "user", uuid: "u1", timestamp: ts, cwd, message: { role: "user", content: [{ type: "text", text: "Look at [Image #1]" }, png] } },
        { type: "assistant", uuid: "a1", timestamp: ts, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: join(cwd, "plan.pdf") } }] } },
        {
          type: "user",
          uuid: "r1u",
          timestamp: ts,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" } }] }] },
          toolUseResult: { type: "pdf", file: { filePath: join(cwd, "plan.pdf"), base64: "JVBERg==" } },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("Attachments (2)"));
    const lines = view.frame().split("\n");
    expect(lines.findIndex((l) => l.includes("Attachments (2)"))).toBeGreaterThan(lines.findIndex((l) => l.includes("Plans (")));
    expect(view.frame()).toContain("▤ ");
    expect(view.frame()).toContain("plan.pdf");
    expect(view.frame()).toMatch(/▣2 .*Look at/);
    await view.press("o");
    await until(() => view.frame().includes("Attachments of this session · 2"));
    expect(view.frame()).toMatch(/⎘ #1 \d\d:\d\d pasted image · Look at \[Image #1\][\s\S]*▶ ▤  1 \d\d:\d\d plan\.pdf/);
    await view.press("\u001b");
    await until(() => !view.frame().includes("Attachments of this session"));
  });
});
