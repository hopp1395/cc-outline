import { describe, expect, it } from "vitest";
import { doubleClicks, isCtrlEnter } from "../src/tui/openKey.js";

describe("isCtrlEnter", () => {
  it("takes a line feed and the extended-key forms, not plain Enter", () => {
    expect(isCtrlEnter("\n")).toBe(true);
    expect(isCtrlEnter("\u001b[13;5u")).toBe(true);
    expect(isCtrlEnter("\u001b[27;5;13~")).toBe(true);
    expect(isCtrlEnter("\r")).toBe(false);
    expect(isCtrlEnter("\u001b\r")).toBe(false);
  });
});

describe("doubleClicks", () => {
  it("counts two quick clicks on the same entry", () => {
    const click = doubleClicks(400);
    expect(click(3, 1000)).toBe(false);
    expect(click(3, 1300)).toBe(true);
  });

  it("does not count slow clicks, clicks on another entry or a third click", () => {
    const click = doubleClicks(400);
    expect(click(3, 1000)).toBe(false);
    expect(click(3, 1500)).toBe(false);
    expect(click(4, 1600)).toBe(false);
    expect(click(4, 1700)).toBe(true);
    expect(click(4, 1800)).toBe(false);
  });
});
