import { describe, expect, it } from "vitest";
import { bodyHeightBelow, fitHeader, moreBadge, previewWindow, scrollAtRow, scrollThumb, shiftLine } from "../src/tui/Preview.js";

describe("shiftLine", () => {
  it("scrolls the content but keeps the gutter in place", () => {
    const line = "12 " + "abcdefghijklmnopqrstuvwxyz";
    expect(shiftLine(line, 0, 3, 10)).toBe(line);
    expect(shiftLine(line, 5, 3, 10)).toBe("12 fghijkl");
  });

  it("keeps colours of a shifted line", () => {
    const line = "1 \u001b[32mgreen text here\u001b[39m";
    const shifted = shiftLine(line, 6, 2, 10);
    expect(shifted.replace(/\u001b\[[0-9;]*m/g, "")).toBe("1 text her");
    expect(shifted).toContain("\u001b[32m");
  });
});

describe("fitHeader", () => {
  const header = ["line 1", "line 2", "line 3", "line 4", "───"];

  it("keeps a header that fits into half the height", () => {
    expect(fitHeader(header, 20)).toEqual(header);
  });

  it("shortens a tall header but keeps the separator", () => {
    expect(fitHeader(header, 6)).toEqual(["line 1", "line 2", "───"]);
  });
});

describe("bodyHeightBelow", () => {
  it("leaves at least one line for content", () => {
    expect(bodyHeightBelow(["a", "b"], 10)).toBe(8);
    expect(bodyHeightBelow(["a", "b"], 2)).toBe(1);
  });
});

describe("previewWindow", () => {
  it("shows everything when the content fits", () => {
    expect(previewWindow(5, 0, 10)).toEqual({ from: 0, to: 5, above: 0, below: 0 });
  });

  it("puts a bottom indicator on the last row at the top", () => {
    expect(previewWindow(20, 0, 5)).toEqual({ from: 0, to: 4, above: 0, below: 16 });
  });

  it("puts indicators on both edges in the middle", () => {
    expect(previewWindow(20, 5, 5)).toEqual({ from: 6, to: 9, above: 6, below: 11 });
  });

  it("shows the last line at the bottom", () => {
    expect(previewWindow(20, 15, 5)).toEqual({ from: 16, to: 20, above: 16, below: 0 });
  });

  it("has no indicators in very small previews", () => {
    expect(previewWindow(20, 5, 2)).toEqual({ from: 5, to: 7, above: 0, below: 0 });
  });
});

describe("scrollThumb", () => {
  it("has none when the content fits", () => {
    expect(scrollThumb(10, 0, 10)).toBeUndefined();
  });

  it("is sized by the share shown", () => {
    expect(scrollThumb(40, 0, 10)?.size).toBe(3);
    expect(scrollThumb(10_000, 0, 10)?.size).toBe(1);
    expect(scrollThumb(11, 0, 10)?.size).toBe(8);
  });

  it("touches the ends only at the top and the end", () => {
    expect(scrollThumb(40, 0, 10)).toEqual({ start: 0, size: 3 });
    expect(scrollThumb(40, 30, 10)).toEqual({ start: 7, size: 3 });
    expect(scrollThumb(40, 1, 10)?.start).toBe(1);
    expect(scrollThumb(40, 29, 10)?.start).toBe(6);
    expect(scrollThumb(40, 15, 10)?.start).toBe(4);
  });
});

describe("scrollAtRow", () => {
  it("maps the track onto the scroll range", () => {
    expect(scrollAtRow(0, 40, 10)).toBe(0);
    expect(scrollAtRow(9, 40, 10)).toBe(30);
    expect(scrollAtRow(3, 40, 10)).toBe(10);
  });
});

describe("moreBadge", () => {
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

  it("centres the count and key on a background", () => {
    const badge = moreBadge("end", 15, 60);
    const plain = strip(badge);
    expect(plain.trim()).toBe("↓ 15 more lines (ctrl+End)");
    // 28 columns with its padding: indent (60 - 28) / 2 = 16, plus the badge's own leading space.
    expect(plain.length - plain.trimStart().length).toBe(17);
    expect(badge).toContain("\u001b[48;2;");
  });

  it("points up to ctrl+Home and counts one line", () => {
    expect(strip(moreBadge("top", 1, 60)).trim()).toBe("↑ 1 more line (ctrl+Home)");
  });

  it("drops the key, then the unit, when it does not fit", () => {
    expect(strip(moreBadge("end", 15, 20)).trim()).toBe("↓ 15 more lines");
    expect(strip(moreBadge("end", 15, 12)).trim()).toBe("↓ 15 more");
  });
});
