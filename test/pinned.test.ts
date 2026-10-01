import { describe, expect, it } from "vitest";
import { afterUnpin, nextMarkedIn, nextPinnedRow, pinnedRows, screenOrder, stepRow } from "../src/pinned.js";

describe("screenOrder", () => {
  it("lists the shown entries top to bottom, bottom-up when reversed", () => {
    expect(screenOrder(3, undefined, false)).toEqual([0, 1, 2]);
    expect(screenOrder(3, undefined, true)).toEqual([2, 1, 0]);
    expect(screenOrder(5, [1, 3], true)).toEqual([3, 1]);
  });
});

describe("pinnedRows", () => {
  const marked = (i: number) => i === 1 || i === 3;

  it("puts the marked entries on top, in screen order, above the whole list", () => {
    expect(pinnedRows([0, 1, 2, 3], marked, 0, false)).toEqual({ order: [1, 3, 0, 1, 2, 3], count: 2, row: 2 });
    expect(pinnedRows([3, 2, 1, 0], marked, 0, false)).toEqual({ order: [3, 1, 3, 2, 1, 0], count: 2, row: 5 });
  });

  it("selects the pinned copy only while the selection is in the group", () => {
    expect(pinnedRows([0, 1, 2, 3], marked, 3, true)?.row).toBe(1);
    expect(pinnedRows([0, 1, 2, 3], marked, 3, false)?.row).toBe(5);
    // Not marked (any more): its row in the list.
    expect(pinnedRows([0, 1, 2, 3], marked, 2, true)?.row).toBe(4);
    expect(pinnedRows([0, 1], marked, 3, false)?.row).toBe(-1);
  });

  it("gives no group when nothing shown is marked", () => {
    expect(pinnedRows([0, 2], marked, 0, false)).toBeUndefined();
  });
});

describe("stepRow", () => {
  it("steps through the rows, stopping at the ends", () => {
    expect(stepRow(4, 1, 1)).toBe(2);
    expect(stepRow(4, 3, 1)).toBe(3);
    expect(stepRow(4, 1, -5)).toBe(0);
    expect(stepRow(4, -1, 1)).toBe(0);
    expect(stepRow(0, 0, 1)).toBeUndefined();
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

  it("returns undefined past the last mark", () => {
    expect(nextMarkedIn([0, 1, 2], 1, 1, marked)).toBeUndefined();
    expect(nextMarkedIn([0, 1, 2], 1, -1, marked)).toBeUndefined();
    expect(nextMarkedIn([0, 1, 2], 1, 1, () => false)).toBeUndefined();
  });
});

describe("nextPinnedRow", () => {
  const rows = (row: number) => ({ order: [1, 3, 0, 1, 2, 3], count: 2, row });

  it("steps through the group's rows", () => {
    expect(nextPinnedRow(rows(0), 1)).toBe(1);
    expect(nextPinnedRow(rows(1), -1)).toBe(0);
    expect(nextPinnedRow(rows(1), 1)).toBeUndefined();
    expect(nextPinnedRow(rows(0), -1)).toBeUndefined();
  });

  it("goes from the list below up to the group's last row, not down", () => {
    expect(nextPinnedRow(rows(4), -1)).toBe(1);
    expect(nextPinnedRow(rows(2), 1)).toBeUndefined();
    expect(nextPinnedRow(rows(-1), -1)).toBeUndefined();
  });
});

describe("afterUnpin", () => {
  const rows = (row: number) => ({ order: [1, 3, 5, 0, 1, 2, 3, 5], count: 3, row });

  it("hands the selection to the pinned row below, at the end to the one above", () => {
    expect(afterUnpin(rows(0))).toBe(1);
    expect(afterUnpin(rows(2))).toBe(1);
  });

  it("leaves the selection with the entry when it was the only one or is not in the group", () => {
    expect(afterUnpin({ order: [1, 0, 1], count: 1, row: 0 })).toBeUndefined();
    expect(afterUnpin(rows(4))).toBeUndefined();
    expect(afterUnpin(undefined)).toBeUndefined();
  });
});
