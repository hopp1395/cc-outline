import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { highlight } from "../src/render/highlight.js";
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

  it("keeps long lines whole without wrapping", () => {
    const lines = renderMarkdown(`${"word ".repeat(20).trim()}\n\n\`\`\`\n${"x".repeat(100)}\n\`\`\``, 30, false);
    const plain = lines.map(strip);
    expect(plain.some((l) => l.includes("word ".repeat(19) + "word"))).toBe(true);
    expect(plain.some((l) => l.includes("x".repeat(100)))).toBe(true);
  });

  it("does not start wrapped paragraph lines with a space", () => {
    const plain = renderMarkdown("word ".repeat(40), 30).map(strip);
    expect(plain.length).toBeGreaterThan(1);
    for (const l of plain) expect(l).not.toMatch(/^ /);
  });

  const table = [
    "| ID | Status | Befund |",
    "|---|:-:|---|",
    "| AC-1 | PASSED | Abbruch während eines laufenden Werkzeugaufrufs hält die Antwort in der Oberfläche sofort an |",
    "| AC-6 | GAP | ok |",
  ].join("\n");

  it("keeps a table that fits at its natural width", () => {
    const lines = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 60).map(strip);
    expect(lines).toEqual(["┌───┬───┐", "│ a │ b │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"]);
  });

  it("fits a wide table into the width and wraps inside its cells", () => {
    const lines = renderMarkdown(table, 50).map(strip);
    for (const line of lines) expect(stringWidth(line)).toBe(50);
    expect(lines[0].startsWith("┌")).toBe(true);
    expect(lines.at(-1)!.startsWith("└")).toBe(true);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^[│├].*[│┤]$/);
    expect(lines).toContain("│ AC-6 │  GAP   │ ok                             │");
  });

  it("breaks cells after slashes and hyphens before breaking inside a word", () => {
    const md = "| Datei | Art |\n|---|---|\n| `src/render/markdown.ts` | Tabellen-Renderer |";
    const lines = renderMarkdown(md, 30).map(strip);
    expect(lines).toContain("│ src/render/  │ Tabellen-   │");
    expect(lines).toContain("│ markdown.ts  │ Renderer    │");
  });

  it("closes a style at a cell's line break and reopens it on the next line", () => {
    const lines = renderMarkdown("| Datei | Art |\n|---|---|\n| \u001b[33msrc/render/markdown.ts\u001b[39m | x |", 24);
    expect(lines).toContain("\u001b[2m│\u001b[22m \u001b[33msrc/render/\u001b[0m    \u001b[2m│\u001b[22m x   \u001b[2m│\u001b[22m");
    expect(lines).toContain("\u001b[2m│\u001b[22m \u001b[33mmarkdown.ts\u001b[39m\u001b[0m    \u001b[2m│\u001b[22m     \u001b[2m│\u001b[22m");
  });

  it("keeps tables at their natural width when lines are not wrapped", () => {
    const lines = renderMarkdown(table, 30, false).map(strip);
    expect(lines[0].startsWith("┌")).toBe(true);
    expect(stringWidth(lines[0])).toBeGreaterThan(100);
    expect(lines.filter((l) => l.startsWith("│ AC-1"))).toHaveLength(1);
  });

  it("lists the rows as header: value when the columns get too narrow", () => {
    const lines = renderMarkdown(table, 30).map(strip);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(30);
    expect(lines.slice(0, 3)).toEqual(["ID: AC-1", "Status: PASSED", "Befund: Abbruch während eines"]);
    expect(lines).toContain("Status: GAP");
    expect(lines.join("\n")).not.toContain("│");
  });

  it("indents nested lists under their item's text", () => {
    const md = "- one\n- two\n  - nested a\n  - nested b\n- [ ] open\n- [x] done\n\n3. three\n4. four\n   1. inner";
    expect(renderMarkdown(md, 60).map(strip)).toEqual([
      "  * one",
      "  * two",
      "    * nested a",
      "    * nested b",
      "  * [ ] open",
      "  * [X] done",
      "",
      "  3. three",
      "  4. four",
      "     1. inner",
    ]);
  });

  it("keeps the blocks of loose list items and lists inside quotes", () => {
    const md = "1. first\n\n   more\n\n2. code:\n\n   ```\n   x = 1\n   ```\n\n> - a\n> - b";
    expect(renderMarkdown(md, 60).map(strip)).toEqual([
      "  1. first",
      "     more",
      "  2. code:",
      "       x = 1",
      "",
      "    * a",
      "    * b",
    ]);
  });

  it("renders headings, rules, quotes and inline styles", () => {
    const lines = renderMarkdown("# Top\n\n## Sub\n\n---\n\n> said **this**\n\nA ~~b~~ `c &amp; d` &lt;e&gt;", 20);
    expect(lines.map(strip)).toEqual(["# Top", "", "## Sub", "", "-".repeat(20), "", "  said this", "", "A b c & d <e>"]);
    expect(lines[0]).toBe("\u001b[35m\u001b[4m\u001b[1m# Top\u001b[22m\u001b[24m\u001b[39m");
    // The quote's italic survives the nested bold's close.
    expect(lines[6]).toContain("\u001b[1mthis\u001b[22m");
  });

  it("highlights code blocks, detects a missing language and leaves unknown ones plain yellow", () => {
    const lines = renderMarkdown("```csharp\npublic class A { }\n```\n\n```nosuchlang\nx y\n```", 60);
    expect(lines[0]).toContain("\u001b[38;2;86;156;214mpublic\u001b[39m");
    expect(lines).toContain("  \u001b[33mx y\u001b[39m");
  });
});

describe("highlight", () => {
  it("continues an outer scope's colour after a nested token", () => {
    // C#'s "#region" is a meta scope with a nested keyword.
    const out = highlight("#region x", "csharp");
    expect(out.replace(/\u001b\[[0-9;]*m/g, "")).toBe("#region x");
    expect(out).toMatch(/\u001b\[38;2;155;155;155m x\u001b\[39m$/);
  });
});
