import { describe, expect, it } from "vitest";
import { TranscriptParser } from "../src/transcript/parse.js";
import { barBackground, SESSION_BARS } from "../src/tui/layout.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";

describe("session colour", () => {
  it("takes the last agent-color entry (/color), not a subagent's", () => {
    const parser = new TranscriptParser();
    expect(parser.color).toBeUndefined();
    expect(parser.push(line({ type: "agent-color", agentColor: "red", sessionId: "s" }))).toBe(true);
    expect(parser.color).toBe("red");
    // Claude Code repeats the entry; that changes nothing.
    expect(parser.push(line({ type: "agent-color", agentColor: "red", sessionId: "s" }))).toBe(false);
    expect(parser.push(line({ type: "agent-color", agentColor: "blue", sessionId: "s", isSidechain: true }))).toBe(false);
    expect(parser.push(line({ type: "agent-color", agentColor: "green", sessionId: "s" }))).toBe(true);
    expect(parser.color).toBe("green");
    expect(parser.turns).toEqual([]);
  });

  it("colours the top bar with it, darker without the focus, and keeps the blue bar without one", () => {
    expect(barBackground("green", true)).toBe(SESSION_BARS.green.focused);
    expect(barBackground("green", false)).toBe(SESSION_BARS.green.unfocused);
    expect(barBackground(undefined, true)).toBe("#0e2f55");
    expect(barBackground(undefined, false)).toBeUndefined();
    // A colour cco does not know (e.g. "default") is like none.
    expect(barBackground("default", true)).toBe("#0e2f55");
    for (const name of ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]) expect(SESSION_BARS[name]).toBeDefined();
  });
});
