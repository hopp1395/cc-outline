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
  it("frames browser actions with tools off and lists their screenshots with o", async () => {
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [turn], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Claude in Chrome · 2 actions · 2 screenshots");
    expect(app.frame()).toContain("▣ screenshot · 10×10 [▣ 1] (o)");
    expect(app.frame()).toContain("o 2 attachments");
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Attachments of this turn · 2");
    expect(app.frame()).toMatch(/▶ ▣ 2 ↕ scroll\s+Next page/);
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).not.toContain("Attachments of this turn");
    app.unmount();
  });

  it("lists the prompt's pasted images before the screenshots", async () => {
    const pasted: Turn = { ...turn, id: "p", attachments: [{ kind: "image" }] };
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [pasted], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("o 3 attachments");
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Attachments of this turn · 3");
    expect(app.frame()).toMatch(/ {2}⎘ #1 pasted image[\s\S]*▣  1 ▣ screenshot[\s\S]*▶ ▣  2 ↕ scroll/);
    await app.press("\u001b");
    await expect.poll(app.frame, { timeout: 2000 }).not.toContain("Attachments of this turn");
    app.unmount();
  });

  it("marks the images and PDFs other tools returned, even with tools off, and counts them in the list", async () => {
    const read = (id: string, file: string, kind?: "pdf") => ({
      kind: "tool" as const,
      id,
      name: "Read",
      input: { file_path: `C:/work/${file}` },
      outcome: { status: "ok" as const, summary: kind ?? "image", images: [{ name: file, ...(kind ? { kind } : {}) }] },
    });
    const tools: Turn = { ...turn, id: "r", blocks: [...turn.blocks, read("3", "diagram.png"), read("4", "Ticket.pdf", "pdf")] };
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [tools], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("▣ diagram.png [▣ 3] (o)");
    expect(app.frame()).toContain("▤ Ticket.pdf [▤ 1] (o)");
    expect(app.frame()).toContain("1 tool image · 2 screenshots · 1 PDF (o)");
    expect(app.frame()).toContain("▣4 check the page");
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Attachments of this turn · 4");
    expect(app.frame()).toMatch(/▣ 3 diagram\.png[\s\S]*▶ ▤ 1 Ticket\.pdf/);
    app.unmount();
  });

  it("marks a pasted image's placeholder in the prompt and adds those without one", async () => {
    const pasted: Turn = { id: "p", prompt: "compare [Image #4] with this", attachments: [{ kind: "image" }, { kind: "image" }], blocks: [{ kind: "text", text: "Same." }], done: true };
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [pasted], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("compare [Image #4] with this [Image #5] (o)");
    expect(app.raw()).toContain("\u001b[36m[Image #4]");
    expect(app.frame()).toContain("📎 2 pasted images (o)");
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).toMatch(/⎘ #4 pasted image[\s\S]*▶ ⎘ #5 pasted image/);
    app.unmount();
  });

  it("says so when a turn has no images", async () => {
    const plain: Turn = { id: "n", prompt: "hi", blocks: [{ kind: "text", text: "Hello." }], done: true };
    const app = renderInk(
      <ChatView cwd={join(tmpdir(), "cco-shots")} path="s.jsonl" transcript={{ turns: [plain], plans: [], agents: [], version: 1 }} layout={layout} active />,
      { columns: 120, rows: 24 },
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("Hello.");
    await app.press("o");
    await expect.poll(app.frame, { timeout: 2000 }).toContain("no attachments in this turn");
    app.unmount();
  });
});
