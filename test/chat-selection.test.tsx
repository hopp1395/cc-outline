import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { savePositions } from "../src/positions.js";
import type { Turn } from "../src/transcript/parse.js";
import { ChatView } from "../src/tui/ChatView.js";
import type { Layout } from "../src/tui/layout.js";
import type { Transcript } from "../src/tui/useTranscript.js";

const layout: Layout = { columns: 120, rows: 20, listWidth: 30, previewWidth: 87, bodyHeight: 16 };
const turn = (id: string, answer: string): Turn => ({ id, prompt: `prompt ${id}`, blocks: [{ kind: "text", text: answer }], done: true });
const transcript = (turns: Turn[], version: number): Transcript => ({ turns, plans: [], agents: [], version });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-chat-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

function renderChat() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 20 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const view = (path: string, t: Transcript) => <ChatView cwd={cwd} path={path} transcript={t} layout={layout} active={false} liveSession />;
  const app = render(view("new.jsonl", transcript([turn("r", "Answer resume")], 1)), {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  return { frame: () => frame, show: (path: string, t: Transcript) => app.rerender(view(path, t)), unmount: () => app.unmount() };
}

const cwd = join(tmpdir(), "cco-chat-project");
const resumed = transcript([turn("a", "Answer one"), turn("b", "Answer two"), turn("c", "Answer three")], 1);

describe("ChatView selection", () => {
  it("restores a turn selected before, also when a session without it was shown in between (/resume)", async () => {
    savePositions(cwd, "chat", { selected: "b", follow: false, scroll: {} });
    const chat = renderChat();
    await expect.poll(chat.frame, { timeout: 2000 }).toContain("Answer resume");
    chat.show("resumed.jsonl", resumed);
    await expect.poll(chat.frame, { timeout: 2000 }).toContain("Answer two");
    chat.unmount();
  });

  it("selects the newest turn of a session whose turns come with the switch to it (/resume)", async () => {
    const chat = renderChat();
    await expect.poll(chat.frame, { timeout: 2000 }).toContain("Answer resume");
    // The resumed session, read at once with the transcripts before it.
    chat.show("resumed.jsonl", resumed);
    await expect.poll(chat.frame, { timeout: 2000 }).toContain("Answer three");
    expect(chat.frame()).not.toContain("Answer one");
    chat.unmount();
  });
});
