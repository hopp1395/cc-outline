import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportOptionsFile,
  exportSessions,
  freeName,
  importArchive,
  importSummary,
  newestExport,
  readExportOptions,
  saveExportOptions,
} from "../src/export/archive.js";
import { folderStamp, ImageSource, loadSession, sessionJson, sessionMarkdown, type ExportOptions } from "../src/export/session.js";
import { crc32, readZip, ZipWriter } from "../src/export/zip.js";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import { boxesAsQuotes, BOX_END, BOX_RULE, BOX_START } from "../src/render/markdown.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import { lastActive, SessionReader, type SessionSummary } from "../src/transcript/sessions.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const line = (entry: object) => JSON.stringify(entry) + "\n";
const cwd = join(tmpdir(), "cco-export-project");
let saved: string | undefined;
let out: string;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-export-"));
  out = mkdtempSync(join(tmpdir(), "cco-export-out-"));
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const OPTS: ExportOptions = { tools: "compact", thinking: false, agents: "reports", stats: true };

/** A session with a prompt with an image, an answer with a tool call and a subagent, and an interrupted second prompt. */
function writeSession(id: string): SessionSummary {
  const path = join(projectDir(cwd), `${id}.jsonl`);
  const at = (min: number) => `2026-10-02T10:${String(min).padStart(2, "0")}:00.000Z`;
  writeFileSync(
    path,
    line({ type: "custom-title", customTitle: "Export demo", sessionId: id }) +
      line({
        type: "user",
        uuid: "u1",
        timestamp: at(0),
        cwd,
        gitBranch: "main",
        message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text", text: "Explain this screen" }] },
      }) +
      line({ type: "assistant", uuid: "a1", timestamp: at(1), message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "thinking", thinking: "secret thoughts" }], usage: { output_tokens: 1200, input_tokens: 10 } } }) +
      line({ type: "assistant", uuid: "a2", timestamp: at(1), message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { output_tokens: 1200, input_tokens: 10 } } }) +
      line({ type: "user", uuid: "r1", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] }, toolUseResult: { stdout: "a.txt", stderr: "" } }) +
      line({ type: "assistant", uuid: "a3", timestamp: at(2), message: { id: "m2", model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Agent", input: { description: "Map the repo", subagent_type: "Explore", prompt: "List all projects" } }] } }) +
      line({
        type: "user",
        uuid: "r2",
        timestamp: at(3),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Found 12 projects." }] }] },
        toolUseResult: { status: "completed", agentId: "ag1", totalTokens: 5000, totalDurationMs: 60000, totalToolUseCount: 3, content: [{ type: "text", text: "Found 12 projects." }] },
      }) +
      line({ type: "assistant", uuid: "a4", timestamp: at(4), message: { id: "m3", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "It shows the **login** page." }], stop_reason: "end_turn" } }) +
      line({ type: "user", uuid: "u2", timestamp: at(5), cwd, message: { role: "user", content: "Now fix it" } }) +
      line({ type: "user", uuid: "u3", timestamp: at(6), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
  );
  // The subagent's own transcript and a file history.
  const sub = join(projectDir(cwd), id, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, "agent-ag1.jsonl"),
    line({ type: "user", uuid: "s1", isSidechain: true, timestamp: at(2), message: { role: "user", content: "List all projects" } }) +
      line({ type: "assistant", uuid: "s2", isSidechain: true, timestamp: at(3), message: { id: "sm1", role: "assistant", content: [{ type: "text", text: "Twelve of them." }], stop_reason: "end_turn" } }),
  );
  mkdirSync(join(claudeDir(), "file-history", id), { recursive: true });
  writeFileSync(join(claudeDir(), "file-history", id, "v1"), "old");
  return new SessionReader(path).update();
}

describe("zip", () => {
  it("writes an archive it reads back, stored and deflated, with UTF-8 names", async () => {
    const file = join(out, "t.zip");
    const zip = new ZipWriter(file);
    await zip.add("a/short.txt", "hi");
    await zip.add("a/lång.txt", "x".repeat(5000));
    await zip.add("a/short.txt", "skipped: added twice");
    zip.close();
    const entries = readZip(file);
    expect(entries.map((e) => e.name)).toEqual(["a/short.txt", "a/lång.txt"]);
    expect(entries[0]!.data().toString()).toBe("hi");
    expect(entries[1]!.data().toString()).toBe("x".repeat(5000));
    // Deflated: the archive is much smaller than its contents.
    expect(readFileSync(file).length).toBeLessThan(1000);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("refuses a file that is no zip archive", () => {
    const file = join(out, "no.zip");
    writeFileSync(file, "not a zip");
    expect(() => readZip(file)).toThrow(/not a zip/);
  });
});

describe("frames as quotes", () => {
  it("turns a frame into a quote under its title, without colours", () => {
    const md = `before\n\n${BOX_START}Question\n\u001b[32mYou: yes\u001b[39m\n\n${BOX_RULE}\n\nmore\n${BOX_END}`;
    expect(boxesAsQuotes(md)).toBe("before\n\n> **Question**\n>\n> You: yes\n>\n> ---\n>\n> more");
  });
});

describe("session documents", () => {
  it("writes a readable Markdown document with the head, prompts, stats, tools, the agent's report and the image", () => {
    const session = loadSession(writeSession("s1"));
    const { text, files } = sessionMarkdown(session, OPTS, "markdown", new ImageSource());
    expect(text).toContain("# Export demo");
    expect(text).toContain("- **Resume:** `claude --resume s1`");
    expect(text).toContain("- **Branch:** `main`");
    expect(text).toMatch(/## 1 · ❯ Prompt · 2026-10-02 \d\d:00/);
    expect(text).toContain("> Explain this screen");
    expect(text).toContain("![Image 1](attachments/turn-001-image-1.png)");
    expect(text).toContain("↓ 1.2k tokens");
    expect(text).toContain("**⚙ Bash**");
    expect(text).toContain("**◆ Explore · Map the repo**");
    expect(text).toContain("> Found 12 projects.");
    expect(text).toContain("It shows the **login** page.");
    expect(text).toContain("*⊘ Interrupted by user*");
    expect(text).not.toContain("secret thoughts");
    expect(files.map((f) => f.name)).toEqual(["attachments/turn-001-image-1.png"]);
    expect((files[0]!.data() as Buffer).toString("base64")).toBe(PNG);
  });

  it("writes the slim document for a language model: roles, no stats, at most compact tools", () => {
    const session = loadSession(writeSession("s1"));
    const { text } = sessionMarkdown(session, { ...OPTS, tools: "full", thinking: true }, "llm", new ImageSource());
    expect(text).toMatch(/## User \(2026-10-02 \d\d:00\)\n\nExplain this screen/);
    expect(text).toContain("## Claude");
    expect(text).toContain("> secret thoughts");
    expect(text).not.toContain("tokens ·");
    expect(text).not.toContain("Resume");
    // Compact: the call's line, not its command and output.
    expect(text).toContain("**⚙ Bash**");
    expect(text).not.toContain("```sh");
  });

  it("writes a subagent's whole conversation into a file of its own and links it", () => {
    const session = loadSession(writeSession("s1"));
    const { text, files } = sessionMarkdown(session, { ...OPTS, agents: "full" }, "markdown", new ImageSource());
    expect(text).toContain("[Whole conversation](agents/Explore-ag1.md)");
    const doc = files.find((f) => f.name === "agents/Explore-ag1.md")!.data() as string;
    expect(doc).toContain("## Task");
    expect(doc).toContain("Twelve of them.");
  });

  it("leaves the agents out with none", () => {
    const session = loadSession(writeSession("s1"));
    const { text } = sessionMarkdown(session, { ...OPTS, agents: "none" }, "markdown", new ImageSource());
    expect(text).not.toContain("Map the repo");
  });

  it("writes the JSON document with turns, blocks as far as the options let them in, and the image's file", () => {
    const session = loadSession(writeSession("s1"));
    const { text } = sessionJson(session, OPTS, new ImageSource());
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: "cco-session-export", version: 1, session: { id: "s1", title: "Export demo", branch: "main" } });
    expect(doc.turns[0]).toMatchObject({ id: "u1", kind: "prompt", prompt: "Explain this screen", done: true, attachments: [{ kind: "image", file: "attachments/turn-001-image-1.png" }] });
    expect(doc.turns[0].stats.output).toBe(1200);
    const types = doc.turns[0].blocks.map((b: { type: string }) => b.type);
    expect(types).toEqual(["tool", "agent", "text"]);
    // Compact: no input.
    expect(doc.turns[0].blocks[0].input).toBeUndefined();
    expect(doc.turns[1]).toMatchObject({ prompt: "Now fix it", interrupted: "user" });
  });
});

describe("export archive", () => {
  it("writes all four formats per session into one archive and numbers a taken name", async () => {
    const s = writeSession("s1aaaaaaaa");
    const first = await exportSessions([s], OPTS, { viewerCwd: cwd, dir: out });
    expect(first.file).toBe(join(out, "cco-session-export.zip"));
    const second = await exportSessions([s], OPTS, { viewerCwd: cwd, dir: out });
    expect(second.file).toBe(join(out, "cco-session-export (2).zip"));
    expect(freeName(out, "cco-session-export")).toBe(join(out, "cco-session-export (3).zip"));
    const stamp = folderStamp(lastActive(s));
    const names = readZip(first.file).map((e) => e.name);
    for (const format of ["markdown", "llm", "json", "backup"]) expect(names.some((n) => n.startsWith(`${stamp}-s1aaaaaa-${format}/`))).toBe(true);
    expect(names).toContain(`${stamp}-s1aaaaaa-markdown/session.md`);
    expect(names).toContain(`${stamp}-s1aaaaaa-json/session.json`);
    expect(names).toContain(`${stamp}-s1aaaaaa-backup/manifest.json`);
    expect(names).toContain(`${stamp}-s1aaaaaa-backup/claude/file-history/s1aaaaaaaa/v1`);
    expect(names.some((n) => n.endsWith("/subagents/agent-ag1.jsonl"))).toBe(true);
    // No partial file is left.
    expect(existsSync(`${first.file}.part`)).toBe(false);
    expect(newestExport(out)).toMatch(/cco-session-export/);
  });

  it("imports the backups back, with cco's marks, and skips a session that is there", async () => {
    const s = writeSession("s1");
    toggleFavorite(cwd, "turns", "u1");
    toggleFavorite(cwd, "sessions", "s1");
    const { file } = await exportSessions([s], OPTS, { viewerCwd: cwd, dir: out });
    // Gone, as on another machine.
    rmSync(claudeDir(), { recursive: true, force: true });
    const result = importArchive(file, cwd);
    expect(result.imported).toEqual([{ id: "s1", title: "Export demo" }]);
    expect(readFileSync(join(projectDir(cwd), "s1.jsonl"), "utf8")).toContain("Explain this screen");
    expect(existsSync(join(projectDir(cwd), "s1", "subagents", "agent-ag1.jsonl"))).toBe(true);
    expect(readFileSync(join(claudeDir(), "file-history", "s1", "v1"), "utf8")).toBe("old");
    expect(readFavorites(cwd, "turns")).toEqual(["u1"]);
    expect(readFavorites(cwd, "sessions")).toEqual(["s1"]);
    const again = importArchive(file, cwd);
    expect(again.imported).toEqual([]);
    expect(again.skipped).toEqual([{ id: "s1", title: "Export demo", reason: "already there" }]);
    expect(importSummary(again)).toBe("imported 0 sessions · skipped 1 (already there)");
  });

  it("refuses an archive without backups", async () => {
    const file = join(out, "empty.zip");
    const zip = new ZipWriter(file);
    await zip.add("x/session.md", "# hi");
    zip.close();
    expect(() => importArchive(file, cwd)).toThrow(/no session backups/);
  });

  it("does not write outside ~/.claude", async () => {
    const file = join(out, "evil.zip");
    const zip = new ZipWriter(file);
    const manifest = { format: "cco-session-backup", version: 1, id: "e1", ids: ["e1"], slug: "x", files: [], summary: { id: "e1", prompts: [] } };
    await zip.add("f-backup/manifest.json", JSON.stringify(manifest));
    await zip.add("f-backup/claude/../../evil.txt", "x");
    zip.close();
    const result = importArchive(file, cwd);
    expect(result.skipped[0]!.reason).toMatch(/unsafe path/);
    expect(existsSync(join(claudeDir(), "..", "evil.txt"))).toBe(false);
  });
});

describe("export options", () => {
  it("starts from the chat's tools and thinking and remembers the last choice", () => {
    expect(readExportOptions()).toEqual({ tools: "off", thinking: false, agents: "reports", stats: true });
    saveExportOptions({ tools: "full", thinking: true, agents: "full", stats: false });
    expect(readExportOptions()).toEqual({ tools: "full", thinking: true, agents: "full", stats: false });
    writeFileSync(exportOptionsFile(), JSON.stringify({ tools: "loud", agents: 3 }));
    expect(readExportOptions()).toEqual({ tools: "off", thinking: false, agents: "reports", stats: true });
  });
});
