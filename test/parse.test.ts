import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";

const fixture = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

describe("TranscriptParser", () => {
  it("builds one turn per real prompt", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    expect(p.turns.map((t) => t.prompt)).toEqual([
      "Explain **hooks**",
      "/color green",
      "Second prompt",
      "also add tests",
    ]);
  });

  it("starts a turn for a prompt sent while Claude was working", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    const [before, queued] = p.turns.slice(-2);
    expect(before.queued).toBeUndefined();
    expect(before.blocks).toEqual([{ kind: "text", text: "Working on it." }]);
    expect(queued).toMatchObject({ id: "q1", prompt: "also add tests", queued: true });
    expect(queued.blocks).toEqual([{ kind: "text", text: "Tests added." }]);
  });

  it("takes the text of a queued prompt with a pasted image", () => {
    const queued = (uuid: string, prompt: unknown) =>
      JSON.stringify({ type: "attachment", uuid, attachment: { type: "queued_command", prompt, humanTurn: true } }) + "\n";
    const p = new TranscriptParser();
    p.push(
      queued("q1", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "what is on this screenshot?" },
      ]) + queued("q2", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]),
    );
    expect(p.turns.map((t) => t.prompt)).toEqual(["what is on this screenshot?"]);
  });

  describe("turn state", () => {
    const line = (entry: object) => JSON.stringify(entry) + "\n";
    const prompt = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
    const assistant = (stop: string | null, content: object[] = [{ type: "text", text: "…" }], extra = {}) =>
      line({ type: "assistant", message: { id: "m", content, stop_reason: stop }, ...extra });
    const userText = (text: string, extra = {}) =>
      line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });

    it("is running until Claude ends its turn", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "fix it") + assistant("tool_use", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]));
      expect(p.turns[0].done).toBe(false);
      p.push(assistant("end_turn"));
      expect(p.turns[0].done).toBe(true);
      expect(p.turns[0].interrupted).toBeUndefined();
    });

    it("is done after the turn_duration entry", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "fix it") + assistant(null));
      expect(p.turns[0].done).toBe(false);
      expect(p.push(line({ type: "system", subtype: "turn_duration", durationMs: 5 }))).toBe(true);
      expect(p.turns[0].done).toBe(true);
    });

    it("marks interrupts without starting a turn", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "one") + assistant("tool_use") + userText("[Request interrupted by user for tool use]"));
      p.push(prompt("b", "two") + userText("[Request interrupted by user]"));
      expect(p.turns.map((t) => [t.prompt, t.interrupted, t.done])).toEqual([
        ["one", "tool", true],
        ["two", "user", true],
      ]);
    });

    it("ignores interrupts of subagents", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "one") + userText("[Request interrupted by user]", { isSidechain: true }));
      expect(p.turns[0].interrupted).toBeUndefined();
      expect(p.turns[0].done).toBeUndefined();
    });

    it("ends local commands with their output", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "<command-name>/color</command-name><command-args>green</command-args>"));
      expect(p.turns[0].done).toBeUndefined();
      p.push(userText("<local-command-stdout>Session color set</local-command-stdout>"));
      expect(p.turns[0].done).toBe(true);
    });
  });

  it("collects assistant blocks in order and skips sidechains", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    expect(p.turns[0].blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(JSON.stringify(p.turns)).not.toContain("subagent chatter");
  });

  it("buffers incomplete lines across chunks", () => {
    const p = new TranscriptParser();
    const cut = fixture.indexOf("Second prompt");
    expect(p.push(fixture.slice(0, cut))).toBe(true);
    expect(p.turns).toHaveLength(2);
    expect(p.push(fixture.slice(cut))).toBe(true);
    expect(p.turns).toHaveLength(4);
  });

  it("builds Markdown with optional tools and thinking", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    const turn = p.turns[0];
    expect(turnMarkdown(turn, { tools: false, thinking: false })).toBe(
      "## Hooks\n\n- **Stop** runs after a reply\n\nDone.",
    );
    const full = turnMarkdown(turn, { tools: true, thinking: true });
    expect(full).toContain("> Let me think");
    expect(full).toContain("**⚙ Bash** `ls -la`");
  });
});
