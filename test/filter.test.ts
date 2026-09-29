import { describe, expect, it } from "vitest";
import { compileFilter, editLine, filterIndices, haystack, lineOf, nearestShown, stepShown, toggleFilterIn, type LineState } from "../src/filter.js";

const matches = (query: string, ...fields: string[]) => compileFilter(query)!(haystack(fields));

describe("compileFilter", () => {
  it("is no filter without words", () => {
    expect(compileFilter("")).toBeUndefined();
    expect(compileFilter("   ")).toBeUndefined();
  });

  it("finds a word anywhere, ignoring case", () => {
    expect(matches("plan", "src/tui/PlanView.tsx")).toBe(true);
    expect(matches("PLAN", "the plan view")).toBe(true);
    expect(matches("plan", "src/tui/ChatView.tsx")).toBe(false);
  });

  it("needs every word, in any order and any field", () => {
    expect(matches("view plan", "PlanView")).toBe(true);
    expect(matches("main fix", "fix the parser", "main")).toBe(true);
    expect(matches("main fix", "fix the parser", "develop")).toBe(false);
  });

  it("reads * as any text and ? and _ as one character", () => {
    expect(matches("a*view", "src/tui/ChatView.tsx")).toBe(true);
    expect(matches("pl?n", "the plan")).toBe(true);
    expect(matches("pl_n", "the plan")).toBe(true);
    expect(matches("pl?n", "the pln")).toBe(false);
    expect(matches("*", "anything")).toBe(true);
  });

  it("keeps wildcards within one field", () => {
    expect(matches("chat*main", "ChatView.tsx", "main")).toBe(false);
    expect(matches("chat*main", "chat on main")).toBe(true);
  });

  it("takes other characters literally", () => {
    expect(matches("(1)", "Filter (1)")).toBe(true);
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("c++", "c++ code")).toBe(true);
    expect(matches("[x]", "[x] done")).toBe(true);
  });
});

describe("haystack", () => {
  it("joins the fields one per line, without empty ones and line breaks inside", () => {
    expect(haystack(["a", undefined, "", "b\nc"])).toBe("a\nb c");
  });
});

describe("filterIndices", () => {
  it("returns the natural indexes of the matches", () => {
    expect(filterIndices(["alpha", "beta", "alphabet"], compileFilter("alpha")!)).toEqual([0, 2]);
  });
});

describe("nearestShown", () => {
  it("keeps a shown entry, else takes the nearest before, else the first", () => {
    expect(nearestShown([1, 4, 7], 4)).toBe(4);
    expect(nearestShown([1, 4, 7], 6)).toBe(4);
    expect(nearestShown([3, 4, 7], 1)).toBe(3);
    expect(nearestShown([], 1)).toBeUndefined();
  });
});

describe("stepShown", () => {
  it("steps through the shown entries and stops at the ends", () => {
    expect(stepShown([1, 4, 7], 4, 1)).toBe(7);
    expect(stepShown([1, 4, 7], 4, -1)).toBe(1);
    expect(stepShown([1, 4, 7], 7, 1)).toBe(7);
    expect(stepShown([1, 4, 7], 1, -5)).toBe(1);
    expect(stepShown([1, 4, 7], 1, 10)).toBe(7);
  });

  it("starts from where a hidden selection would be", () => {
    expect(stepShown([1, 4, 7], 5, 1)).toBe(7);
    expect(stepShown([1, 4, 7], 5, -1)).toBe(4);
    expect(stepShown([], 5, 1)).toBeUndefined();
  });
});

describe("editLine", () => {
  const at = (text: string, cursor: number): LineState => ({ text, cursor, selected: false });

  it("replaces the selected text with the first character typed", () => {
    expect(editLine(lineOf("old"), "n", {})).toEqual(at("n", 1));
  });

  it("clears the selected text with Backspace, keeps it with → and edits after", () => {
    expect(editLine(lineOf("old"), "", { backspace: true })).toEqual(at("", 0));
    const kept = editLine(lineOf("old"), "", { rightArrow: true });
    expect(kept).toEqual(at("old", 3));
    expect(editLine(kept, "er", {})).toEqual(at("older", 5));
  });

  it("inserts and deletes at the cursor", () => {
    expect(editLine(at("ac", 1), "b", {})).toEqual(at("abc", 2));
    expect(editLine(at("abc", 2), "", { backspace: true })).toEqual(at("ac", 1));
    expect(editLine(at("abc", 1), "", { delete: true })).toEqual(at("ac", 1));
    expect(editLine(at("abc", 0), "", { backspace: true })).toEqual(at("abc", 0));
  });

  it("moves the cursor with ←→ and Home/End", () => {
    expect(editLine(at("abc", 1), "", { leftArrow: true })).toEqual(at("abc", 0));
    expect(editLine(at("abc", 0), "", { leftArrow: true })).toEqual(at("abc", 0));
    expect(editLine(at("abc", 1), "", { end: true })).toEqual(at("abc", 3));
    expect(editLine(at("abc", 2), "", { home: true })).toEqual(at("abc", 0));
  });

  it("clears with Ctrl+U", () => {
    expect(editLine(at("abc", 2), "u", { ctrl: true })).toEqual(at("", 0));
  });

  it("inserts a pasted text with its line breaks as spaces", () => {
    expect(editLine(at("", 0), "one\r\ntwo", {})).toEqual(at("one two", 7));
  });

  it("ignores other Ctrl keys and mouse or focus reports", () => {
    const line = at("abc", 1);
    expect(editLine(line, "f", { ctrl: true })).toBe(line);
    expect(editLine(line, "[<0;12;5M", {})).toBe(line);
    expect(editLine(line, "[I", {})).toBe(line);
  });
});

describe("toggleFilterIn", () => {
  it("adds a part that is off and drops one that is on, never both", () => {
    expect(toggleFilterIn("list", "details")).toBe("both");
    expect(toggleFilterIn("both", "details")).toBe("list");
    expect(toggleFilterIn("both", "list")).toBe("details");
    // The last one switched off hands over to the other.
    expect(toggleFilterIn("list", "list")).toBe("details");
    expect(toggleFilterIn("details", "details")).toBe("list");
    expect(toggleFilterIn("details", "list")).toBe("both");
  });
});
