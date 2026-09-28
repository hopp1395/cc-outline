import { describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { Turn } from "../src/transcript/parse.js";
import { answerLines, jumpHint, PROMPT_PREVIEW_CHARS, promptHeader } from "../src/tui/ChatView.js";

describe("jumpHint", () => {
  it("centres the badge and gives it a background", () => {
    const hint = jumpHint(60);
    const plain = strip(hint);
    const left = plain.length - plain.trimStart().length;
    expect(plain.trim()).toBe("↓ Jump to bottom (ctrl+End)");
    // Badge is 29 columns incl. its padding: indent (60 - 29) / 2 = 15, plus the badge's own leading space.
    expect(left).toBe(16);
    expect(hint).toContain("\u001b[48;2;");
  });
});

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
    const lines = promptHeader("word ".repeat(150), 40, 12);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(strip(lines.at(-1)!)).toContain("↵ full prompt");
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
