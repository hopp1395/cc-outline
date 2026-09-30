import { describe, expect, it } from "vitest";
import { afterUnpin, nextMarkedIn, pinnedRows, screenOrder, stepOrder } from "../src/pinned.js";

describe("screenOrder", () => {
  it("lists the shown entries top to bottom, bottom-up when reversed", () => {
    expect(screenOrder(3, undefined, false)).toEqual([0, 1, 2]);
    expect(screenOrder(3, undefined, true)).toEqual([2, 1, 0]);
    expect(screenOrder(5, [1, 3], true)).toEqual([3, 1]);
  });
});

describe("pinnedRows", () => {
  it("moves the marked entries to the top, in screen order", () => {
    const marked = (i: number) => i === 1 || i === 3;
    expect(pinnedRows([0, 1, 2, 3], marked)).toEqual({ order: [1, 3, 0, 2], count: 2 });
    expect(pinnedRows([3, 2, 1, 0], marked)).toEqual({ order: [3, 1, 2, 0], count: 2 });
  });

  it("gives no group when nothing shown is marked", () => {
    expect(pinnedRows([0, 2], (i) => i === 1)).toBeUndefined();
  });
});

describe("stepOrder", () => {
  it("steps through the rows on screen, stopping at the ends", () => {
    const order = [1, 3, 0, 2];
    expect(stepOrder(order, 3, 1)).toBe(0);
    expect(stepOrder(order, 0, -1)).toBe(3);
    expect(stepOrder(order, 2, 1)).toBe(2);
    expect(stepOrder(order, 1, -5)).toBe(1);
    expect(stepOrder(order, 9, 1)).toBe(1);
    expect(stepOrder([], 0, 1)).toBeUndefined();
  });
});

describe("nextMarkedIn", () => {
  const marked = (i: number) => i === 1 || i === 3;

  it("finds the next and previous marked entry on screen", () => {
    expect(nextMarkedIn([0, 1, 2, 3, 4], 0, 1, marked)).toBe(1);
    expect(nextMarkedIn([0, 1, 2, 3, 4], 1, 1, marked)).toBe(3);
    expect(nextMarkedIn([4, 3, 2, 1, 0], 4, 1, marked)).toBe(3);
    expect(nextMarkedIn([4, 3, 2, 1, 0], 1, -1, marked)).toBe(3);
  });

  it("goes from the rest up into the Pinned group", () => {
    expect(nextMarkedIn([1, 3, 0, 2], 2, -1, marked)).toBe(3);
    expect(nextMarkedIn([1, 3, 0, 2], 0, 1, marked)).toBeUndefined();
  });

  it("returns undefined past the last mark", () => {
    expect(nextMarkedIn([0, 1, 2], 1, 1, marked)).toBeUndefined();
    expect(nextMarkedIn([0, 1, 2], 1, -1, marked)).toBeUndefined();
    expect(nextMarkedIn([0, 1, 2], 1, 1, () => false)).toBeUndefined();
  });
});

describe("afterUnpin", () => {
  const rows = { order: [1, 3, 5, 0, 2], count: 3 };

  it("hands the selection to the pinned row below, at the end to the one above", () => {
    expect(afterUnpin(rows, 1)).toBe(3);
    expect(afterUnpin(rows, 5)).toBe(3);
  });

  it("leaves the selection with the entry when it was the only one or is not pinned", () => {
    expect(afterUnpin({ order: [1, 0], count: 1 }, 1)).toBeUndefined();
    expect(afterUnpin(rows, 0)).toBeUndefined();
    expect(afterUnpin(undefined, 1)).toBeUndefined();
  });
});
