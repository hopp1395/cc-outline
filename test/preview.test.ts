import { describe, expect, it } from "vitest";
import { bodyHeightBelow, fitHeader, shiftLine } from "../src/tui/Preview.js";

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
