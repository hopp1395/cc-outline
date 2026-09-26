import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff.js";
import { addedLines, languageFor, renderDiff, renderFile } from "../src/render/diff.js";

describe("renderFile", () => {
  const content = "class A\r\n{\r\n    int x;\r\n    int y;\r\n}\r\n";
  const change = parseDiff(["@@ -1,4 +1,5 @@", " class A", " {", "+    int x;", "+    int y;", " }"].join("\n"));

  it("numbers every line without change markers", () => {
    expect([...addedLines(change)]).toEqual([3, 4]);
    const { lines, hunkStarts } = renderFile(content, "a.cs", 40, addedLines(change));
    expect(lines.map(strip)).toEqual(["1 class A", "2 {", "3     int x;", "4     int y;", "5 }"]);
    expect(lines.some((l) => l.includes("\u001b[48;"))).toBe(false);
    // Jumps still target the changed block.
    expect(hunkStarts).toEqual([2]);
  });
});

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const diff = parseDiff(
  [
    "@@ -1,4 +1,4 @@",
    " /* multi-line",
    "    comment */",
    "-public class Old { }",
    "+public class New { string s = \"a very long string literal that will need to be wrapped\"; }",
    " // end",
  ].join("\n"),
);

describe("renderDiff", () => {
  it("maps C# files to the csharp highlighter only", () => {
    expect(languageFor("src/Foo.CS")).toBe("csharp");
    expect(languageFor("readme.md")).toBeUndefined();
  });

  it("renders gutters, signs and wraps long lines within the width", () => {
    const { lines, hunkStarts } = renderDiff(diff, "a.cs", 50);
    expect(hunkStarts).toEqual([0]);
    const plain = lines.map(strip);
    expect(plain[1]).toBe("1 1   /* multi-line");
    expect(plain[3]).toMatch(/^3   - public class Old \{ \}/);
    expect(plain[4]).toMatch(/^  3 \+ public class New/);
    expect(plain[5]).toMatch(/^ {6}\S/); // continuation line under the code column
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(50);
  });

  it("highlights code spanning lines and backgrounds changed lines", () => {
    const { lines } = renderDiff(diff, "a.cs", 80);
    // The second comment line is coloured although "/*" is on the line before.
    expect(lines[2]).toContain("\u001b[38;2;106;153;85m");
    expect(lines[3].startsWith("\u001b[48;2;72;30;34m")).toBe(true);
    expect(lines[4].startsWith("\u001b[48;2;30;58;36m")).toBe(true);
  });

  it("keeps long lines whole when wrapping is off", () => {
    const { lines, gutterWidth } = renderDiff(diff, "a.cs", 50, false);
    expect(lines).toHaveLength(6); // header + 5 code lines, none wrapped
    expect(gutterWidth).toBe(6);
    expect(strip(lines[4])).toContain("will need to be wrapped\"; }");
  });

  it("does not highlight other languages", () => {
    const { lines } = renderDiff(diff, "a.txt", 80);
    expect(lines[2]).not.toContain("\u001b[38;2");
  });
});
