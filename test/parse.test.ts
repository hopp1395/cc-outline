import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";

const fixture = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

describe("TranscriptParser", () => {
  it("builds one turn per real prompt", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    expect(p.turns.map((t) => t.prompt)).toEqual(["Explain **hooks**", "/color green", "Second prompt"]);
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
    expect(p.turns).toHaveLength(3);
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
