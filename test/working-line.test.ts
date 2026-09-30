import { describe, expect, it } from "vitest";
import type { Turn } from "../src/transcript/parse.js";
import { spinnerMarks, workingLine } from "../src/tui/ChatView.js";

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const turn = (tools: number): Turn =>
  ({
    blocks: [
      { kind: "text", text: "Looking." },
      ...Array.from({ length: tools }, (_, i) => ({ kind: "tool", id: `t${i}`, name: "Read", input: {} })),
    ],
  }) as unknown as Turn;

describe("workingLine", () => {
  it("counts the tool calls while they are hidden", () => {
    expect(plain(workingLine(turn(3), "off"))).toBe("⠿ Claude is working… · 3 tool calls");
    expect(plain(workingLine(turn(1), "off"))).toBe("⠿ Claude is working… · 1 tool call");
  });

  it("leaves the count out without calls or while they are shown", () => {
    expect(plain(workingLine(turn(0), "off"))).toBe("⠿ Claude is working…");
    expect(plain(workingLine(turn(3), "compact"))).toBe("⠿ Claude is working…");
    expect(plain(workingLine(turn(3), "full"))).toBe("⠿ Claude is working…");
  });

  it("still spins", () => {
    expect(spinnerMarks([workingLine(turn(2), "off")])).toEqual([{ line: 0, col: 0 }]);
  });
});
