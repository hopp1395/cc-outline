import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentFile, markedPrompt, pastedNumbers, turnAttachments } from "../src/attachments.js";
import { ImageSource, loadSession, sessionJson, sessionMarkdown, type ExportOptions } from "../src/export/session.js";
import { TranscriptParser, turnMarkdown, turnScreenshots } from "../src/transcript/parse.js";
import { mergeContinued, SessionReader, type SessionSummary } from "../src/transcript/sessions.js";
import { markAt, stripAnsi } from "../src/tui/links.js";
import { sessionLines } from "../src/tui/SessionsView.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const PDF = Buffer.from("%PDF-1.7 test").toString("base64");
const png = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } };
const line = (entry: object) => JSON.stringify(entry) + "\n";
const at = (minute: number) => `2026-10-02T10:${String(minute).padStart(2, "0")}:00.000Z`;
const call = (id: string, name: string, input: object, minute: number) =>
  line({ type: "assistant", uuid: `a-${id}`, timestamp: at(minute), message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: object[], toolUseResult: object, minute: number) =>
  line({ type: "user", uuid: `r-${id}`, timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult });

/** A prompt with a pasted image, a browser screenshot, a Read of an image and one of a PDF, and an @-mention. */
const TRANSCRIPT =
  line({ type: "user", uuid: "u1", timestamp: at(1), cwd: "C:/work", message: { role: "user", content: [{ type: "text", text: "what is wrong in [Image #3]?" }, png] } }) +
  line({ type: "attachment", uuid: "x1", attachment: { type: "file", filename: "C:/work/src/Foo.cs", displayPath: "src/Foo.cs", content: "…" } }) +
  call("b1", "mcp__claude-in-chrome__computer", { action: "screenshot" }, 2) +
  result("b1", [png], {}, 2) +
  call("r1", "Read", { file_path: "C:/work/diagram.png" }, 3) +
  result("r1", [png], { type: "image", file: { base64: PNG, type: "image/png" } }, 3) +
  call("r2", "Read", { file_path: "C:/work/Ticket.pdf" }, 4) +
  result("r2", [{ type: "text", text: "PDF file read: C:/work/Ticket.pdf" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } }], { type: "pdf", file: { filePath: "C:/work/Ticket.pdf", base64: PDF } }, 4) +
  line({ type: "assistant", uuid: "a-end", timestamp: at(5), message: { id: "m-end", role: "assistant", content: [{ type: "text", text: "Found it." }], stop_reason: "end_turn" } });

const parsed = () => {
  const p = new TranscriptParser();
  p.push(TRANSCRIPT);
  return p.turns[0]!;
};
const tool = (id: string) => parsed().blocks.find((b) => b.kind === "tool" && b.id === id) as { outcome?: { images?: unknown } };

describe("images and PDFs of tool results", () => {
  it("keeps what a Read returned, named after the file, PDFs apart", () => {
    expect(tool("r1").outcome?.images).toEqual([{ name: "diagram.png" }]);
    expect(tool("r2").outcome?.images).toEqual([{ kind: "pdf", name: "Ticket.pdf" }]);
  });

  it("numbers images through the turn with the browser's screenshots, PDFs on their own", () => {
    expect(turnScreenshots(parsed()).map((s) => [s.kind, s.n, s.block.id])).toEqual([
      ["image", 1, "b1"],
      ["image", 2, "r1"],
      ["pdf", 1, "r2"],
    ]);
  });

  it("marks them after the call, and with tools off on a line of their own (also when copying)", () => {
    const compact = stripAnsi(turnMarkdown(parsed(), { tools: "compact", thinking: false, shotHint: true }));
    expect(compact).toContain("**⚙ Read** `C:/work/diagram.png` · image [▣ 2] (o)");
    expect(compact).toContain("[▤ 1] (o)");
    const off = stripAnsi(turnMarkdown(parsed(), { tools: "off", thinking: false, shotHint: true }));
    expect(off).toContain("▣ diagram.png [▣ 2] (o)");
    expect(off).toContain("▤ Ticket.pdf [▤ 1] (o)");
    const copied = stripAnsi(turnMarkdown(parsed(), { tools: "off", thinking: false, browser: false }));
    expect(copied).toBe("▣ diagram.png [▣ 2]\n\n▤ Ticket.pdf [▤ 1]\n\nFound it.");
  });

  it("finds each kind of mark under the pointer", () => {
    expect(markAt("see [Image #3] (o)", 6)).toEqual({ kind: "pasted", n: 3 });
    expect(markAt("▤ Ticket.pdf \u001b[36m[▤ 1]\u001b[39m", 14)).toEqual({ kind: "pdf", n: 1 });
    expect(markAt("see [Image #3]", 2)).toBeUndefined();
  });
});

describe("pasted images in the prompt", () => {
  it("takes the numbers of the placeholders, then numbers the rest after them", () => {
    expect(pastedNumbers("compare [Image #9] and [Image #10]", 2)).toEqual([9, 10]);
    expect(pastedNumbers("compare [Image #9]", 3)).toEqual([9, 10, 11]);
    expect(pastedNumbers("[Image]", 1)).toEqual([1]);
  });

  it("marks the placeholders and adds those that have none", () => {
    expect(stripAnsi(markedPrompt("[Image]", 1, true))).toBe("[Image #1] (o)");
    expect(stripAnsi(markedPrompt("[2 images]", 2, false))).toBe("[Image #1] [Image #2]");
    expect(stripAnsi(markedPrompt("look at [Image #4]", 2, false))).toBe("look at [Image #4] [Image #5]");
    expect(markedPrompt("look at [Image #4]", 1, false)).toContain("\u001b[36m[Image #4]\u001b[39m");
    expect(markedPrompt("no images", 0, true)).toBe("no images");
  });
});

describe("what can be opened of a turn", () => {
  it("lists pasted images, @-mentions, then tool images and PDFs", () => {
    const items = turnAttachments(parsed(), "s.jsonl");
    expect(items.map((i) => [i.kind, "n" in i ? i.n : undefined, "label" in i ? i.label : "path" in i ? i.path : undefined])).toEqual([
      ["pasted", 3, undefined],
      ["file", undefined, "src/Foo.cs"],
      ["image", 1, "▣ screenshot"],
      ["image", 2, "diagram.png"],
      ["pdf", 1, "Ticket.pdf"],
    ]);
  });

  it("writes a PDF from the transcript to open it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-tool-files-"));
    const transcript = join(dir, `s-${Date.now()}.jsonl`);
    writeFileSync(transcript, TRANSCRIPT);
    const pdf = turnAttachments(parsed(), transcript).find((i) => i.kind === "pdf")!;
    const file = attachmentFile(pdf)!;
    expect(file).toMatch(/r2-1\.pdf$/);
    expect(readFileSync(file).toString()).toBe("%PDF-1.7 test");
    // An @-mention opens where it is, if it is still there.
    const mention = turnAttachments(parsed(), transcript).find((i) => i.kind === "file")!;
    expect(attachmentFile({ ...mention, full: transcript })).toBe(transcript);
    expect(attachmentFile({ ...mention, full: join(dir, "gone.cs") })).toBeUndefined();
  });
});

describe("attachments of a session", () => {
  const read = () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-session-files-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, TRANSCRIPT + line({ type: "user", uuid: "u2", timestamp: at(6), message: { role: "user", content: "again @src/Foo.cs" } }) + line({ type: "attachment", uuid: "x2", attachment: { type: "file", filename: "C:/work/src/Foo.cs", displayPath: "src/Foo.cs" } }));
    return new SessionReader(path).update();
  };

  it("collects them without their data, one entry per mentioned path", () => {
    const s = read();
    expect(s.attachments?.map((a) => [a.kind, a.at])).toEqual([
      ["pasted", at(1)],
      ["file", at(1)],
      ["image", at(2)],
      ["image", at(3)],
      ["pdf", at(4)],
    ]);
    const mention = s.attachments!.find((a) => a.kind === "file");
    expect(mention).toMatchObject({ full: "C:/work/src/Foo.cs", uuids: ["u1", "u2"] });
    expect(s.attachments!.find((a) => a.kind === "pdf")).toMatchObject({ label: "Ticket.pdf", toolUseId: "r2", prompt: "what is wrong in [Image #3]?" });
    expect(JSON.stringify(s.attachments)).not.toContain(PNG);
  });

  it("keeps each once when a session went on in another transcript", () => {
    // The later transcript repeats the earlier one's entries: the same ids.
    const s = read();
    const earlier: SessionSummary = { ...s, id: "a", path: join(s.path, "..", "a.jsonl"), continuedIn: "b" };
    const later: SessionSummary = { ...s, id: "b", path: join(s.path, "..", "b.jsonl") };
    const merged = mergeContinued([earlier, later]);
    expect(merged.map((m) => m.id)).toEqual(["b"]);
    expect(merged[0]!.attachments!.map((a) => [a.kind, "n" in a ? a.n : undefined])).toEqual([
      ["pasted", 3],
      ["file", undefined],
      ["image", 1],
      ["image", 2],
      ["pdf", 1],
    ]);
  });

  it("lists them after the plans, a line each, and tells which line is which", () => {
    const s = read();
    const rows = new Map<number, number>();
    const lines = sessionLines(s, "C:/work", 80, false, undefined, rows).map(stripAnsi);
    const heading = lines.indexOf("Attachments (5)");
    expect(heading).toBeGreaterThan(lines.indexOf("Plans (0)"));
    expect(heading).toBeLessThan(lines.indexOf("Changed files (0)"));
    expect([...rows.entries()].map(([line, i]) => [lines[line]!.trim(), i])).toEqual([
      [expect.stringMatching(/^⎘ \d\d:\d\d \[Image #3\] · what is wrong in \[Image #3\]\?$/), 0],
      [expect.stringMatching(/^@ \d\d:\d\d src\/Foo\.cs \(2×\)$/), 1],
      [expect.stringMatching(/^▣ \d\d:\d\d ▣ screenshot$/), 2],
      [expect.stringMatching(/^▣ \d\d:\d\d diagram\.png$/), 3],
      [expect.stringMatching(/^▤ \d\d:\d\d Ticket\.pdf$/), 4],
    ]);
  });
});

describe("export of tool images and PDFs", () => {
  const OPTS: ExportOptions = { tools: "compact", thinking: false, agents: "reports", stats: false };
  it("writes them under attachments/ and links them", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-export-files-"));
    const path = join(dir, "s1.jsonl");
    writeFileSync(path, TRANSCRIPT);
    const session = loadSession(new SessionReader(path).update());
    const md = sessionMarkdown(session, OPTS, "markdown", new ImageSource());
    expect(md.text).toContain("![Image #3](attachments/turn-001-image-1.png)");
    expect(md.text).toContain("![▣ 1](attachments/turn-001-shot-1.png)");
    expect(md.text).toContain("![▣ 2](attachments/turn-001-tool-image-2.png)");
    expect(md.text).toContain("[▤ 1 Ticket.pdf](attachments/turn-001-pdf-1.pdf)");
    const pdf = md.files.find((f) => f.name === "attachments/turn-001-pdf-1.pdf");
    expect(pdf?.data()?.toString()).toBe("%PDF-1.7 test");
    const json = JSON.parse(sessionJson(session, OPTS, new ImageSource()).text);
    const blocks = json.turns[0].blocks as { id?: string; screenshots?: string[]; pdfs?: string[] }[];
    expect(blocks.find((b) => b.id === "r1")?.screenshots).toEqual(["attachments/turn-001-tool-image-2.png"]);
    expect(blocks.find((b) => b.id === "r2")?.pdfs).toEqual(["attachments/turn-001-pdf-1.pdf"]);
    expect(existsSync(path)).toBe(true);
  });
});
