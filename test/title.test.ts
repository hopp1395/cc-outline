import { describe, expect, it } from "vitest";
import { TranscriptParser } from "../src/transcript/parse.js";
import { terminalTitle } from "../src/tui/title.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";

describe("session title", () => {
  it("takes Claude Code's title, and the one set with /rename over it", () => {
    const parser = new TranscriptParser();
    expect(parser.title).toBeUndefined();
    expect(parser.push(line({ type: "ai-title", aiTitle: "Repo checkout", sessionId: "s" }))).toBe(true);
    expect(parser.title).toBe("Repo checkout");
    expect(parser.push(line({ type: "custom-title", customTitle: " orders ", sessionId: "s" }))).toBe(true);
    expect(parser.push(line({ type: "ai-title", aiTitle: "Something else", sessionId: "s" }))).toBe(false);
    expect(parser.title).toBe("orders");
    // Repeated entries change nothing.
    expect(parser.push(line({ type: "custom-title", customTitle: "orders", sessionId: "s" }))).toBe(false);
    expect(parser.turns).toEqual([]);
  });

  it("uses the session title as it is and keeps control characters out", () => {
    expect(terminalTitle("orders")).toBe("orders");
    expect(terminalTitle("a\u0007b\u001b]0;x")).toBe("a b ]0;x");
    expect(terminalTitle(" ")).toBe("cco");
  });
});
