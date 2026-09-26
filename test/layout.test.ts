import { describe, expect, it } from "vitest";
import {
  fitFooter,
  listWindow,
  MARQUEE_MAX_SCROLL,
  marqueeOffset,
  sliceColumns,
  truncate,
  wrapPath,
  type FooterItem,
} from "../src/tui/layout.js";

describe("wrapPath", () => {
  it("breaks after slashes", () => {
    expect(wrapPath("src/Infrastructure/Persistence/Repo.cs", 20)).toEqual([
      "src/Infrastructure/",
      "Persistence/Repo.cs",
    ]);
  });

  it("splits a segment that is wider than the line", () => {
    expect(wrapPath("a/VeryLongFileNameThatDoesNotFit.cs", 10)).toEqual([
      "a/",
      "VeryLongFi",
      "leNameThat",
      "DoesNotFit",
      ".cs",
    ]);
  });

  it("keeps short paths on one line", () => {
    expect(wrapPath("src/a.cs", 20)).toEqual(["src/a.cs"]);
  });
});

describe("sliceColumns", () => {
  it("returns the visible window of a string", () => {
    expect(sliceColumns("src/Services/Order.cs", 4, 8)).toBe("Services");
    expect(sliceColumns("abc", 0, 10)).toBe("abc");
  });

  it("never splits wide characters", () => {
    // "語" is two columns wide and would straddle the window start.
    expect(sliceColumns("a語b", 2, 2)).toBe("b");
  });
});

describe("truncate", () => {
  it("keeps short text and ellipsises long text to the width", () => {
    expect(truncate("short.cs", 20)).toBe("short.cs");
    expect(truncate("src/Infrastructure/Repo.cs", 10)).toBe("src/Infra…");
  });
});

describe("listWindow", () => {
  it("shows everything without indicators when it fits", () => {
    expect(listWindow(5, 2, 5)).toEqual({ from: 0, to: 5, above: 0, below: 0 });
  });

  it("replaces the last entry with an indicator at the top of a long list", () => {
    expect(listWindow(20, 0, 6)).toEqual({ from: 0, to: 5, above: 0, below: 15 });
  });

  it("replaces the first entry at the bottom", () => {
    expect(listWindow(20, 19, 6)).toEqual({ from: 15, to: 20, above: 15, below: 0 });
  });

  it("uses both indicators in the middle and keeps the selection visible", () => {
    for (let selected = 0; selected < 20; selected++) {
      const w = listWindow(20, selected, 6);
      expect(selected).toBeGreaterThanOrEqual(w.from);
      expect(selected).toBeLessThan(w.to);
      // Entries plus indicator rows fill exactly the height.
      expect(w.to - w.from + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)).toBe(6);
      expect(w.above + (w.to - w.from) + w.below).toBe(20);
    }
    expect(listWindow(20, 10, 6)).toEqual({ from: 8, to: 12, above: 8, below: 8 });
  });
});

describe("fitFooter", () => {
  const items: FooterItem[] = [
    { text: "←→ turn", priority: 4 },
    { text: "↑↓ scroll", priority: 1 },
    { text: "f follow", on: true },
    { text: "t tools", priority: 2 },
    { text: "c copy", priority: 2 },
  ];
  const texts = (width: number) => fitFooter(items, width).map((i) => i.text);

  it("shows everything plus i and q when it fits", () => {
    expect(texts(200)).toEqual(["←→ turn", "↑↓ scroll", "f follow", "t tools", "c copy", "i info", "q quit"]);
  });

  it("drops the lowest priority first, rightmost first among equals", () => {
    expect(texts(60)).toEqual(["←→ turn", "f follow", "t tools", "c copy", "i more", "q quit"]);
    expect(texts(50)).toEqual(["←→ turn", "f follow", "t tools", "i more", "q quit"]);
  });

  it("keeps switched-on options longest and always ends with i and q", () => {
    expect(texts(10)).toEqual(["f follow", "i more", "q quit"]);
  });

  it("never exceeds the width while items can still be dropped", () => {
    for (const width of [35, 40, 50, 60]) {
      const line = fitFooter(items, width)
        .map((i) => (i.on ? ` ${i.text} ` : i.text))
        .join("  ");
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

describe("marqueeOffset", () => {
  it("rests at the start, moves to the end, rests and starts over", () => {
    // 12 ticks rest, 5 columns to move, 12 ticks rest: 29 ticks per round.
    expect(marqueeOffset(0, 5)).toBe(0);
    expect(marqueeOffset(12, 5)).toBe(0);
    expect(marqueeOffset(15, 5)).toBe(3);
    expect(marqueeOffset(20, 5)).toBe(5);
    expect(marqueeOffset(28, 5)).toBe(5);
    expect(marqueeOffset(29, 5)).toBe(0);
  });

  it("moves at most MARQUEE_MAX_SCROLL columns, then starts over", () => {
    const overflow = 2000;
    const round = MARQUEE_MAX_SCROLL + 24;
    const offsets = Array.from({ length: round }, (_, t) => marqueeOffset(t, overflow));
    expect(Math.max(...offsets)).toBe(MARQUEE_MAX_SCROLL);
    expect(marqueeOffset(round, overflow)).toBe(0);
  });

  it("stays put when the text fits", () => {
    expect(marqueeOffset(40, 0)).toBe(0);
  });
});
