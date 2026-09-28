import { describe, expect, it } from "vitest";
import { focusFromInput } from "../src/tui/focus.js";

describe("focusFromInput", () => {
  it("takes focus reports, and keys and clicks as focus", () => {
    expect(focusFromInput("[I")).toBe(true);
    expect(focusFromInput("[O")).toBe(false);
    expect(focusFromInput("j")).toBe(true);
    expect(focusFromInput("[<0;12;5M")).toBe(true);
  });

  it("learns nothing from the wheel or a release", () => {
    expect(focusFromInput("[<65;12;5M")).toBeUndefined();
    expect(focusFromInput("[<0;12;5m")).toBeUndefined();
  });
});
