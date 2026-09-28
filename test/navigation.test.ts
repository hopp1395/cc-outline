import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { handleNavigation, markKeys, orderedNav } from "../src/tui/layout.js";

const key = (k: Partial<Key>): Key => k as Key;

function run(input: string, k: Partial<Key>, reversed = false) {
  const calls: string[] = [];
  const nav = {
    ...orderedNav(reversed, {
      select: (d: number) => calls.push(`select ${d}`),
      first: () => calls.push("first"),
      last: () => calls.push("last"),
    }),
    scroll: {
      scroll: 0,
      max: 100,
      by: (d: number) => calls.push(`scroll ${d}`),
      set: (n: number) => calls.push(`set ${n}`),
    },
    page: 10,
  };
  const handled = handleNavigation(input, key(k), nav as never);
  return { handled, calls };
}

describe("handleNavigation", () => {
  it("switches entries with ↑↓, also on screen in a reversed list", () => {
    expect(run("", { upArrow: true }).calls).toEqual(["select -1"]);
    expect(run("", { downArrow: true }).calls).toEqual(["select 1"]);
    expect(run("", { upArrow: true }, true).calls).toEqual(["select 1"]);
  });

  it("scrolls the preview by page with PgUp/PgDn and by line with Ctrl+↑↓", () => {
    expect(run("", { pageUp: true }).calls).toEqual(["scroll -10"]);
    expect(run("", { pageDown: true }).calls).toEqual(["scroll 10"]);
    expect(run("", { ctrl: true, upArrow: true }).calls).toEqual(["scroll -1"]);
    expect(run("", { ctrl: true, downArrow: true }).calls).toEqual(["scroll 1"]);
  });

  it("swallows Shift+↑↓, which only jumps between marks", () => {
    expect(run("", { shift: true, upArrow: true })).toEqual({ handled: true, calls: [] });
  });

  it("leaves ←→, b and Space alone", () => {
    for (const [input, k] of [["", { leftArrow: true }], ["", { rightArrow: true }], ["b", {}], [" ", {}]] as const) {
      expect(run(input, k)).toEqual({ handled: false, calls: [] });
    }
  });

  it("goes to the first / last entry with Home/End and g/G, to the top / bottom of the preview with Ctrl", () => {
    expect(run("", { home: true }).calls).toEqual(["first"]);
    expect(run("G", {}).calls).toEqual(["last"]);
    expect(run("", { home: true }, true).calls).toEqual(["last"]);
    expect(run("", { ctrl: true, end: true }).calls).toEqual(["set 100"]);
  });
});

describe("markKeys", () => {
  it("marks with Space and jumps between marks with Shift+↑↓", () => {
    expect(markKeys(" ", key({}))).toBe("toggle");
    expect(markKeys("", key({ shift: true, upArrow: true }))).toBe(-1);
    expect(markKeys("", key({ shift: true, downArrow: true }))).toBe(1);
    expect(markKeys("", key({ shift: true, leftArrow: true }))).toBeUndefined();
    expect(markKeys("", key({ upArrow: true }))).toBeUndefined();
  });
});
