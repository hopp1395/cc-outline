import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentFile, turnAttachments } from "../src/attachments.js";
import { holdTranscript, turnImageFile } from "../src/images.js";
import type { RemoteEvent } from "../src/remote/api.js";
import { remotePath } from "../src/remote/index.js";
import { toTranscript } from "../src/remote/toTranscript.js";
import { TranscriptParser } from "../src/transcript/parse.js";
import { attachmentSummary } from "../src/tui/ChatView.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const image = (media_type = "image/png") => ({ type: "image", source: { type: "base64", media_type, data: PNG } });
const line = (entry: object) => JSON.stringify(entry) + "\n";
const prompt = (uuid: string, content: unknown) => line({ type: "user", uuid, message: { role: "user", content } });
const attachment = (attachment: object) => line({ type: "attachment", uuid: "x", attachment });
const assistant = line({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } });

describe("attachments of a prompt", () => {
  it("collects images, their stored copies, @-mentions and selections", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", [image(), image(), { type: "text", text: "compare these with @src/Order.cs" }]) +
        attachment({ type: "inlined_image_paths", paths: ["C:\\up\\a.png", "C:\\up\\b.png"] }) +
        attachment({ type: "file", filename: "W:\\shop\\src\\Order.cs", displayPath: "src\\Order.cs", content: "…" }) +
        attachment({ type: "directory", path: "W:\\shop\\docs", displayPath: "docs" }) +
        attachment({ type: "selected_lines_in_ide", filename: "W:\\shop\\Foo.cs", displayPath: "Foo.cs", lineStart: 3, lineEnd: 14 }) +
        attachment({ type: "total_tokens_reminder" }) +
        assistant,
    );
    expect(p.turns[0].attachments).toEqual([
      { kind: "image", path: "C:\\up\\a.png" },
      { kind: "image", path: "C:\\up\\b.png" },
      { kind: "file", path: "src\\Order.cs", full: "W:\\shop\\src\\Order.cs" },
      { kind: "directory", path: "docs", full: "W:\\shop\\docs" },
      { kind: "selection", lines: 12, file: "Foo.cs" },
    ]);
    expect(attachmentSummary(p.turns[0].attachments!)).toBe(
      "📎 2 pasted images · @src/Order.cs · @docs/ · 12 lines selected in Foo.cs",
    );
  });

  it("leaves out files Claude Code attaches again after /compact", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", "/compact") +
        prompt("u2", "<local-command-stdout>Compacted</local-command-stdout>") +
        attachment({ type: "file", filename: "W:\\shop\\a.py", displayPath: "a.py" }) +
        attachment({ type: "compact_file_reference", filename: "W:\\shop\\b.md" }),
    );
    expect(p.turns.map((t) => t.attachments)).toEqual([undefined]);
  });

  it("keeps turns without attachments free of an empty list", () => {
    const p = new TranscriptParser();
    p.push(prompt("u1", "hi") + attachment({ type: "inlined_image_paths", paths: [] }) + attachment({ type: "date" }));
    expect(p.turns[0].attachments).toBeUndefined();
    expect(attachmentSummary([])).toBeUndefined();
  });

  it("takes the images of a queued prompt", () => {
    const p = new TranscriptParser();
    p.push(line({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: [image()], humanTurn: true } }));
    expect(p.turns[0]).toMatchObject({ prompt: "[Image]", attachments: [{ kind: "image" }] });
  });
});

describe("turnImageFile", () => {
  it("uses the stored copy, else writes the image from the transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-images-test-"));
    const stored = join(dir, "stored.png");
    writeFileSync(stored, "x");
    const transcript = join(dir, "session.jsonl");
    const uuid = `u-${Date.now()}`;
    writeFileSync(
      transcript,
      prompt(uuid, [image(), image("image/jpeg")]) +
        attachment({ type: "inlined_image_paths", paths: [stored, join(dir, "gone.png")] }),
    );
    const p = new TranscriptParser();
    p.push(readFileSync(transcript, "utf8"));
    const files = [0, 1].map((i) => turnImageFile(transcript, p.turns[0], i)!);
    expect(files[0]).toBe(stored);
    expect(files[1]).toMatch(new RegExp(`${uuid}-2\\.jpg$`));
    expect(existsSync(files[1])).toBe(true);
    expect(readFileSync(files[1]).toString("base64")).toBe(PNG);
  });

  it("returns nothing for a turn without images or a missing transcript", () => {
    const p = new TranscriptParser();
    p.push(prompt("u1", [image()]));
    expect(turnImageFile(undefined, p.turns[0], 0)).toBeUndefined();
    expect(turnImageFile(join(tmpdir(), "missing.jsonl"), p.turns[0], 0)).toBeUndefined();
    p.push(prompt("u2", "no images"));
    expect(turnImageFile(undefined, p.turns[1], 0)).toBeUndefined();
  });
});

describe("attachments of a remote session", () => {
  it("opens images and PDFs from the events held in memory for its stand-in path", () => {
    const id = `cse_${Date.now()}`;
    const path = remotePath(id);
    const toolUseId = `toolu_${Date.now()}`;
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: PNG } };
    const events: RemoteEvent[] = [
      { sequence: 1, payload: { type: "user", uuid: `${id}-prompt`, message: { role: "user", content: [image(), { type: "text", text: "what is this?" }] } } },
      { sequence: 2, payload: { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "C:\\a.pdf" } }] } } },
      { sequence: 3, payload: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [pdf] }] } } },
      { sequence: 4, payload: { type: "result", duration_ms: 10 } },
    ];
    const p = new TranscriptParser({ dedupe: true });
    p.push(toTranscript(events).lines.join("\n") + "\n");
    const items = turnAttachments(p.turns[0], path);
    expect(items.map((i) => i.kind)).toEqual(["pasted", "pdf"]);
    // No file at the stand-in path: nothing to open until the events are held.
    expect(attachmentFile(items[0])).toBeUndefined();
    const release = holdTranscript(path, () => toTranscript(events).lines.join("\n"));
    try {
      const files = items.map((i) => attachmentFile(i)!);
      expect(files[0]).toMatch(new RegExp(`${id}-prompt-1\\.png$`));
      expect(files[1]).toMatch(new RegExp(`${toolUseId}-1\\.pdf$`));
      expect(readFileSync(files[1]).toString("base64")).toBe(PNG);
    } finally {
      release();
    }
    // Released (the viewer switched sessions): the stand-in path is no transcript again.
    expect(attachmentFile({ kind: "pasted", n: 1, uuid: `${id}-later`, index: 0, transcript: path })).toBeUndefined();
  });
});
