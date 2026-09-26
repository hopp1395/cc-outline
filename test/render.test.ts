import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("renderMarkdown", () => {
  it("renders inline formatting inside list items", () => {
    const out = renderMarkdown("- **bold** and `code`", 60).map(strip).join("\n");
    expect(out).not.toContain("**");
    expect(out).toContain("bold and code");
  });

  it("keeps every line within the width and indents wrapped list items", () => {
    const lines = renderMarkdown(`- ${"word ".repeat(40)}\n\n\`\`\`\n${"x".repeat(100)}\n\`\`\``, 30);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(30);
    const plain = lines.map(strip);
    expect(plain[1]).toMatch(/^ {4}word/);
  });

  it("does not start wrapped paragraph lines with a space", () => {
    const plain = renderMarkdown("word ".repeat(40), 30).map(strip);
    expect(plain.length).toBeGreaterThan(1);
    for (const l of plain) expect(l).not.toMatch(/^ /);
  });
});
