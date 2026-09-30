import { describe, expect, it } from "vitest";
import { inArea } from "../src/tui/layout.js";
import { linkAt } from "../src/tui/links.js";
import { parseMouse } from "../src/tui/mouse.js";

describe("parseMouse", () => {
  it("reads left clicks and wheel steps, zero-based", () => {
    expect(parseMouse("[<0;12;5M")).toEqual([{ kind: "click", delta: 0, x: 11, y: 4 }]);
    expect(parseMouse("[<64;3;4M")).toEqual([{ kind: "wheel", delta: -1, x: 2, y: 3 }]);
    expect(parseMouse("[<65;3;4M[<65;3;4M").map((e) => e.delta)).toEqual([1, 1]);
  });

  it("reads drags and releases of the left button", () => {
    expect(parseMouse("[<32;12;5M")).toEqual([{ kind: "drag", delta: 0, x: 11, y: 4 }]);
    expect(parseMouse("[<0;12;5m")).toEqual([{ kind: "release", delta: 0, x: 11, y: 4 }]);
  });

  it("reads presses of the right button", () => {
    expect(parseMouse("[<2;12;5M")).toEqual([{ kind: "right", delta: 0, x: 11, y: 4 }]);
  });

  it("ignores other buttons and other input", () => {
    expect(parseMouse("[<1;12;5M")).toEqual([]);
    expect(parseMouse("[<34;12;5M")).toEqual([]);
    expect(parseMouse("[<2;12;5m")).toEqual([]);
    expect(parseMouse("x")).toEqual([]);
    // With a modifier held it is still a click.
    expect(parseMouse("[<16;1;1M")).toEqual([{ kind: "click", delta: 0, x: 0, y: 0 }]);
  });
});

describe("inArea", () => {
  it("maps screen cells into a part of the screen", () => {
    const area = { x: 32, y: 1, width: 70, height: 20 };
    expect(inArea(area, 32, 1)).toEqual({ col: 0, row: 0 });
    expect(inArea(area, 40, 5)).toEqual({ col: 8, row: 4 });
    expect(inArea(area, 31, 5)).toBeUndefined();
    expect(inArea(area, 40, 21)).toBeUndefined();
  });
});

describe("linkAt", () => {
  it("finds the URL under the column, without trailing punctuation", () => {
    const lines = ["See \u001b[34mhttps://github.com/a/b/pull/8\u001b[39m.", "none here"];
    expect(linkAt(lines, 0, 4, 80)).toBe("https://github.com/a/b/pull/8");
    expect(linkAt(lines, 0, 32, 80)).toBe("https://github.com/a/b/pull/8");
    expect(linkAt(lines, 0, 33, 80)).toBeUndefined();
    expect(linkAt(lines, 0, 2, 80)).toBeUndefined();
    expect(linkAt(lines, 1, 2, 80)).toBeUndefined();
  });

  it("joins a URL wrapped onto the next lines, from either half", () => {
    // Wrapped to 36 columns: the first line is full, the second is not, so the third is not part of it.
    const lines = ["Docs: https://example.com/very/long/", "  path/to/the/page?x=1", "  and more text"];
    expect(linkAt(lines, 0, 10, 36)).toBe("https://example.com/very/long/path/to/the/page?x=1");
    expect(linkAt(lines, 1, 5, 36)).toBe("https://example.com/very/long/path/to/the/page?x=1");
    expect(linkAt(lines, 2, 3, 36)).toBeUndefined();
    // A URL that merely ends a short line is not continued.
    expect(linkAt(["see https://a.io/x", "next"], 0, 6, 80)).toBe("https://a.io/x");
  });

  it("counts wide characters before the URL twice", () => {
    expect(linkAt(["📎 https://a.io/x"], 0, 3, 80)).toBe("https://a.io/x");
    expect(linkAt(["📎 https://a.io/x"], 0, 1, 80)).toBeUndefined();
  });
});
