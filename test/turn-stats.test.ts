import { describe, expect, it } from "vitest";
import { TranscriptParser } from "../src/transcript/parse.js";
import { formatCount, shortModel } from "../src/transcript/turnStats.js";
import { promptHeader, turnDetailLines, turnStatsLines } from "../src/tui/ChatView.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const line = (o: object) => JSON.stringify(o) + "\n";
const prompt = (uuid: string, text: string, timestamp = "2026-10-02T10:00:00.000Z") =>
  line({ type: "user", uuid, timestamp, message: { role: "user", content: text } });
const usage = (output: number, input = 10, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
const assistant = (id: string, content: object[], opts: { output?: number; input?: number; cacheRead?: number; model?: string; timestamp?: string; stop?: string } = {}) =>
  line({
    type: "assistant",
    uuid: `${id}-${Math.random()}`,
    timestamp: opts.timestamp ?? "2026-10-02T10:00:05.000Z",
    message: { id, model: opts.model ?? "claude-opus-5-5", content, usage: usage(opts.output ?? 0, opts.input, opts.cacheRead), stop_reason: opts.stop ?? null },
  });
const tool = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, toolUseResult: object, timestamp = "2026-10-02T10:00:20.000Z") =>
  line({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult });

describe("turn stats", () => {
  it("counts each response's usage once, though its lines repeat it", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("p1", "do it") +
        assistant("m1", [{ type: "thinking", thinking: "hm" }], { output: 300, input: 5, cacheRead: 40_000 }) +
        assistant("m1", [{ type: "text", text: "Sure." }], { output: 300, input: 5, cacheRead: 40_000 }) +
        assistant("m2", [{ type: "text", text: "Done." }], { output: 120, input: 2, cacheRead: 41_000, model: "claude-haiku-4-5-20251001", stop: "end_turn" }),
    );
    const s = p.turns[0].stats!;
    expect(s.output).toBe(420);
    expect(s.context).toBe(41_002);
    expect(s.models).toEqual({ "claude-opus-5-5": 300, "claude-haiku-4-5-20251001": 120 });
  });

  it("counts tool calls and the files written, a created one as new", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("p1", "write it") +
        assistant("m1", [tool("t1", "Write", { file_path: "/r/a.ts", content: "one\ntwo\nthree\n" })]) +
        result("t1", { type: "create", filePath: "/r/a.ts" }) +
        assistant("m2", [tool("t2", "Edit", { file_path: "/r/a.ts" })]) +
        result("t2", { filePath: "/r/a.ts", structuredPatch: [{ lines: [" x", "-old", "+new", "+more"] }] }) +
        assistant("m3", [tool("t3", "Edit", { file_path: "/r/b.ts" })]) +
        result("t3", { filePath: "/r/b.ts", structuredPatch: [{ lines: ["-gone"] }] }) +
        assistant("m4", [tool("t4", "Read", { file_path: "/r/c.ts" })]) +
        result("t4", { file: {} }) +
        line({ type: "system", subtype: "turn_duration", durationMs: 134_000 }),
    );
    const s = p.turns[0].stats!;
    expect(s.tools).toBe(4);
    expect(s.toolNames).toEqual({ Write: 1, Edit: 2, Read: 1 });
    expect(s.files).toEqual({ "/r/a.ts": "new", "/r/b.ts": "changed" });
    expect(s.lines).toEqual({ "/r/a.ts": { added: 5, removed: 1 }, "/r/b.ts": { added: 0, removed: 1 } });
    expect([s.added, s.removed]).toEqual([5, 2]);
    expect(s.durationMs).toBe(134_000);
  });

  it("has none for a turn without a response", () => {
    const p = new TranscriptParser();
    p.push(prompt("p1", "! ls"));
    expect(p.turns[0].stats).toBeUndefined();
    expect(turnStatsLines(p.turns[0], [], 80)).toEqual([]);
  });

  it("renders duration, tokens, context, models, tools, agents and files", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("p1", "go") +
        assistant("m1", [tool("t1", "Edit", { file_path: "/r/b.ts" })], { output: 3_200, cacheRead: 84_000 }) +
        result("t1", { filePath: "/r/b.ts", structuredPatch: [{ lines: ["+a", "-b"] }] }) +
        line({ type: "system", subtype: "turn_duration", durationMs: 134_000 }),
    );
    const lines = turnStatsLines(p.turns[0], [{ id: "a", description: "x", status: "completed", tokens: 58_000 }], 200).map(strip);
    expect(lines).toEqual(["2 min 14 s · ↓ 3.2k · ctx 84k · opus-5.5 · 1 tool · + ◆1 58k", "files ~1 · lines +1 −1"]);
  });

  it("takes the time to the turn's last entry when the duration is missing, and counts up while it runs", () => {
    const p = new TranscriptParser();
    p.push(prompt("p1", "go") + assistant("m1", [{ type: "text", text: "…" }], { output: 5, timestamp: "2026-10-02T10:00:45.000Z" }));
    expect(strip(turnStatsLines(p.turns[0], [], 80)[0])).toMatch(/^45 s · /);
    expect(strip(turnStatsLines(p.turns[0], [], 80, Date.parse("2026-10-02T10:01:30.000Z"))[0])).toMatch(/^1 min 30 s · /);
  });

  it("leaves out the last parts that do not fit", () => {
    const p = new TranscriptParser();
    p.push(prompt("p1", "go") + assistant("m1", [{ type: "text", text: "x" }], { output: 3_200, cacheRead: 84_000 }));
    expect(strip(turnStatsLines(p.turns[0], [], 18)[0])).toBe("5 s · ↓ 3.2k");
  });

  it("lists the details in full: time, tokens per model, tools per name, agents and files with their lines", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("p1", "go") +
        assistant("m1", [tool("t1", "Edit", { file_path: "/r/src/b.ts" }), tool("t2", "Write", { file_path: "/r/a.ts", content: "x\ny\n" })], { output: 3_000, cacheRead: 84_000 }) +
        result("t1", { filePath: "/r/src/b.ts", structuredPatch: [{ lines: ["+a", "+b", "-c"] }] }) +
        result("t2", { type: "create", filePath: "/r/a.ts" }) +
        assistant("m2", [tool("t3", "Edit", { file_path: "/r/src/b.ts" })], { output: 200, model: "claude-haiku-4-5-20251001" }) +
        result("t3", { filePath: "/r/src/b.ts", structuredPatch: [{ lines: ["+d"] }] }) +
        line({ type: "system", subtype: "turn_duration", durationMs: 134_000 }),
    );
    const agent = { id: "a", type: "Explore", description: "find it", status: "completed" as const, tokens: 31_000, toolUses: 12, durationMs: 65_000 };
    const lines = turnDetailLines(p.turns[0], [agent], 80, "/r").map(strip);
    expect(lines).toEqual([
      "$ Details",
      "─".repeat(80),
      expect.stringMatching(/^\d\d:\d\d – \d\d:\d\d · 2 min 14 s$/),
      "",
      "Tokens",
      "  ↓ 3.2k  opus-5.5 3k · haiku-4.5 200",
      "  ctx 10",
      "",
      "Tools  3",
      "  Edit 2 · Write 1",
      "",
      "Agents  1 · 31k",
      '  ◆ Explore "find it"',
      "    ✓ completed · 1 min 05 s · 12 tool uses · 31k tokens",
      "",
      "Files  +1 ~1 · +5 −1",
      "  + a.ts      +2",
      "  ~ src/b.ts  +3 −1",
    ]);
  });

  it("has no details for a turn without a response, and says while the turn runs", () => {
    const p = new TranscriptParser();
    p.push(prompt("p1", "! ls"));
    expect(turnDetailLines(p.turns[0], [], 80, "/r")).toEqual([]);
    const q = new TranscriptParser();
    q.push(prompt("p1", "go") + assistant("m1", [{ type: "text", text: "…" }], { output: 5 }));
    expect(strip(turnDetailLines(q.turns[0], [], 80, "/r", Date.parse("2026-10-02T10:01:30.000Z"))[2])).toMatch(/^\d\d:\d\d – running · 1 min 30 s$/);
  });

  it("shows below the prompt, above the rule", () => {
    const lines = promptHeader("fix it", 40, 20, [], ["5 s · ↓ 12"]).map(strip);
    expect(lines).toEqual(["❯ fix it", "$ 5 s · ↓ 12", "─".repeat(40)]);
  });
});

describe("formatting", () => {
  it("shortens model names", () => {
    expect(shortModel("claude-opus-5-5")).toBe("opus-5.5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
    expect(shortModel("claude-sonnet-4-20250514")).toBe("sonnet-4");
    expect(shortModel("gpt-x")).toBe("gpt-x");
  });

  it("formats counts", () => {
    expect([840, 3_200, 10_000, 84_400, 1_250_000].map(formatCount)).toEqual(["840", "3.2k", "10k", "84k", "1.3M"]);
  });
});
