import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff.js";
import { languageFor, renderDiff } from "../src/render/diff.js";

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

  it("does not highlight other languages", () => {
    const { lines } = renderDiff(diff, "a.txt", 80);
    expect(lines[2]).not.toContain("\u001b[38;2");
  });
});
