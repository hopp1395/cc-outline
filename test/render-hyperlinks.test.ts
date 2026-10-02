import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown.js";
import { terminalFeatures } from "../src/render/terminal.js";

const real = { ...terminalFeatures };
beforeAll(() => {
  terminalFeatures.hyperlinks = true;
});
afterAll(() => {
  Object.assign(terminalFeatures, real);
});

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("renderMarkdown with hyperlinks", () => {
  it("writes links as OSC 8 hyperlinks", () => {
    const [line] = renderMarkdown("see [Socket](https://socket.dev/x)", 60);
    expect(line).toContain("\u001b]8;;https://socket.dev/x\u0007");
  });

  it("writes links in table cells out, so breaks after / and - cannot cut them apart", () => {
    const md = "| # | Beschreibung |\n|---|---|\n| 4 | Punkt 2, siehe [Socket](https://socket.dev/npm/package/cc-outline) |";
    const lines = renderMarkdown(md, 30);
    for (const line of lines) {
      expect(line).not.toContain("\u001b]8;");
      expect(stringWidth(line)).toBe(30);
    }
    const cells = lines.filter((l) => strip(l).startsWith("│")).map((l) => strip(l).slice(6, -1).trim());
    expect(cells.join("")).toContain("Socket(https://socket.dev/npm/package/cc-outline)");
  });
});
