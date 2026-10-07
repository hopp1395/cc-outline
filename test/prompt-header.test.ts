import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { Turn } from "../src/transcript/parse.js";
import { answerLines, commandName, compactLines, continuationDetails, PROMPT_PREVIEW_CHARS, PROMPT_PREVIEW_LINES, promptHeader } from "../src/tui/ChatView.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("promptHeader", () => {
  it("shows a short prompt completely without hint", () => {
    const lines = promptHeader("fix the bug", 40, 20).map(strip);
    expect(lines[0]).toBe("❯ fix the bug");
    expect(lines.at(-1)).toBe("─".repeat(40));
  });

  it("limits the excerpt to the character budget and points to the full prompt", () => {
    const prompt = "x".repeat(PROMPT_PREVIEW_CHARS + 500);
    const lines = promptHeader(prompt, 1000, 1000).map(strip);
    const shown = lines.slice(0, -1).join("").replace(/^❯ /, "").replace(/\s/g, "");
    expect(shown).toBe("x".repeat(PROMPT_PREVIEW_CHARS) + "…");
    expect(lines.at(-1)).toMatch(/^── ↵ full prompt ─+$/);
  });

  it("never takes more than half the height", () => {
    const lines = promptHeader("word ".repeat(150), 40, 8);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(strip(lines.at(-1)!)).toContain("↵ full prompt");
  });

  it("shows at most PROMPT_PREVIEW_LINES rows, the last ending in …", () => {
    const lines = promptHeader("word ".repeat(150), 40, 100).map(strip);
    expect(lines).toHaveLength(PROMPT_PREVIEW_LINES + 1);
    expect(lines.at(-2)).toMatch(/…$/);
    expect(lines.at(-2)!.length).toBeLessThanOrEqual(40);
    expect(lines.at(-1)).toMatch(/^── ↵ full prompt ─+$/);
  });

  it("leaves blank lines out without claiming the prompt was cut", () => {
    const lines = promptHeader("first\n\n\nsecond\n  \nthird", 40, 100).map(strip);
    expect(lines).toEqual(["❯ first", "  second", "  third", "─".repeat(40)]);
  });

  it("shows a prompt of exactly PROMPT_PREVIEW_LINES rows completely", () => {
    const prompt = ["one", "two", "three", "four", "five"].join("\n");
    const lines = promptHeader(prompt, 40, 100).map(strip);
    expect(lines.slice(0, -1).join("")).not.toContain("…");
    expect(lines.at(-1)).toBe("─".repeat(40));
  });
});

describe("answerLines", () => {
  it("sets a recap apart from the answer, where it was written", () => {
    const turn: Turn = {
      id: "a",
      prompt: "fix it",
      blocks: [
        { kind: "text", text: "Fixed." },
        { kind: "recap", text: "Goal: fix it." },
      ],
    };
    const lines = answerLines(turn, { tools: "off", thinking: false, agents: false }, 40, true).map(stripAnsi);
    expect(lines).toEqual(["Fixed.", "", "▌ ※ Recap", "▌ Goal: fix it."]);
  });
});

describe("continuationDetails", () => {
  it("names the sessions, the compaction, the background and how to resume", () => {
    expect(
      continuationDetails({
        sessionId: "b32b44ad-f910",
        fromSessionId: "e109d6b4-bd08",
        compact: { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 },
        backgrounded: true,
      }),
    ).toEqual([
      "session e109d6b4 → b32b44ad",
      "/compact · 217k → 10k tokens · 43 s",
      "sent to the background, run by the Claude Code daemon",
      "claude --resume b32b44ad-f910",
    ]);
    expect(continuationDetails({ sessionId: "next" })).toEqual(["session (earlier, not found) → next", "claude --resume next"]);
  });
});

describe("compactLines", () => {
  it("heads the summary with what the compaction reported", () => {
    const lines = compactLines("Goal: fix it.", { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 }, 60, true).map(stripAnsi);
    expect(lines).toEqual(["⟳ Compact summary · /compact · 217k → 10k tokens · 43 s", "", "Goal: fix it."]);
  });
});

describe("slash commands", () => {
  it("names the command a prompt runs, not a path", () => {
    expect(commandName("/model sonnet")).toBe("/model");
    expect(commandName("/cco:chat")).toBe("/cco:chat");
    expect(commandName("/usr/bin is missing")).toBeUndefined();
    expect(commandName("fix /model")).toBeUndefined();
  });

  it("shows the command's name in colour above the answer, without claiming the prompt was cut", () => {
    const header = promptHeader("/model sonnet", 40, 10);
    expect(header[0]).toContain("\u001b[38;2;217;119;87m/model\u001b[39m");
    expect(header.map(stripAnsi)).toEqual(["❯ /model sonnet", "─".repeat(40)]);
  });
});
