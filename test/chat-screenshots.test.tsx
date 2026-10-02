import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import type { Turn } from "../src/transcript/parse.js";
import { ChatView } from "../src/tui/ChatView.js";
import type { Layout } from "../src/tui/layout.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 30, previewWidth: 87, bodyHeight: 20 };
const shot = (id: string, action: string, page: string) => ({
  kind: "tool" as const,
  id,
  name: "mcp__claude-in-chrome__computer",
  input: { action },
  outcome: { status: "ok" as const, summary: "10×10", page, images: [{}] },
});
const turn: Turn = {
  id: "t",
  prompt: "check the page",
  blocks: [shot("1", "screenshot", "Start page"), shot("2", "scroll", "Next page"), { kind: "text", text: "Done." }],
  done: true,
};

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-shots-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("ChatView screenshots", () => {
  it("frames browser actions with tools off and lists their screenshots with O", async () => {
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [turn], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Claude in Chrome · 2 actions · 2 screenshots");
    expect(app.frame()).toContain("▣ screenshot · 10×10 [▣ 1]");
    expect(app.frame()).toContain("o/O 2 screenshots");
    await app.press("O");
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Screenshots of this turn · 2");
    expect(app.frame()).toMatch(/▶ 2 ↕ scroll\s+Next page/);
    await app.press("\u001b");
    await expect.poll(app.frame, { timeout: 2000 }).not.toContain("Screenshots of this turn");
    app.unmount();
  });
});
