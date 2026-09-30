import { describe, expect, it } from "vitest";
import { highlightColumns, selectedColumns, selectedText, type Selection } from "../src/tui/selection.js";

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const sel = (anchor: [number, number], focus: [number, number], from = 0): Selection => ({
  anchor: { line: anchor[0], col: anchor[1] },
  focus: { line: focus[0], col: focus[1] },
  from,
});

describe("selectedColumns", () => {
  it("takes both ends, in either direction", () => {
    for (const s of [sel([1, 4], [3, 2]), sel([3, 2], [1, 4])]) {
      expect(selectedColumns(s, 0)).toBeUndefined();
      expect(selectedColumns(s, 1)).toEqual([4, Infinity]);
      expect(selectedColumns(s, 2)).toEqual([0, Infinity]);
      expect(selectedColumns(s, 3)).toEqual([0, 3]);
      expect(selectedColumns(s, 4)).toBeUndefined();
    }
  });

  it("leaves a gutter out on every line", () => {
    expect(selectedColumns(sel([0, 6], [1, 2], 4), 1)).toBeUndefined();
    expect(selectedColumns(sel([0, 6], [2, 8], 4), 1)).toEqual([4, Infinity]);
  });
});

describe("selectedText", () => {
  const lines = ["  1 \u001b[32mconst a = 1;\u001b[39m   ", "  2 ", "  3 \u001b[33mreturn a;\u001b[39m"];

  it("copies the text between the ends without colours or trailing spaces", () => {
    expect(selectedText(lines, sel([0, 10], [2, 9]))).toBe("a = 1;\n  2\n  3 return");
  });

  it("copies code without its line numbers", () => {
    expect(selectedText(lines, sel([0, 4], [2, 20], 4))).toBe("const a = 1;\n\nreturn a;");
  });

  it("counts wide characters as two columns", () => {
    expect(selectedText(["📎 file.ts"], sel([0, 3], [0, 6]))).toBe("file");
  });
});

describe("highlightColumns", () => {
  it("inverts the selected part and keeps the rest", () => {
    const line = "abc \u001b[32mgreen\u001b[39m end";
    const out = highlightColumns(line, 4, 9);
    expect(plain(out)).toBe("abc green end");
    expect(out).toContain("\u001b[7mgreen\u001b[27m");
  });

  it("marks a blank line inside the selection", () => {
    expect(highlightColumns("", 0, Infinity)).toBe("\u001b[7m \u001b[27m");
  });
});
