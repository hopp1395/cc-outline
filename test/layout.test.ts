import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import {
  fitFooter,
  flipOrder,
  leadParts,
  orderedNav,
  orderFooter,
  scrollPosition,
  listWindow,
  nextWindow,
  scrollMargin,
  MARQUEE_MAX_SCROLL,
  marqueeOffset,
  sliceColumns,
  tabAt,
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

describe("leadParts", () => {
  const lead = { columns: 6, color: "cyan" };
  it("splits off what is visible of an entry's lead, also while it scrolls", () => {
    expect(leadParts("/model sonnet", 0, lead)).toEqual(["/model", " sonnet"]);
    // Scrolled by 4 columns: "el" of "/model" is left.
    expect(leadParts("el sonnet", 4, lead)).toEqual(["el", " sonnet"]);
    expect(leadParts("sonnet", 7, lead)).toEqual(["", "sonnet"]);
    expect(leadParts("fix it", 0)).toEqual(["", "fix it"]);
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
    expect(listWindow(5, 2, 5)).toEqual({ start: 0, from: 0, to: 5, above: 0, below: 0 });
  });

  it("replaces the last entry with an indicator at the top of a long list", () => {
    expect(listWindow(20, 0, 6)).toEqual({ start: 0, from: 0, to: 5, above: 0, below: 15 });
  });

  it("replaces the first entry at the bottom", () => {
    expect(listWindow(20, 19, 6)).toEqual({ start: 14, from: 15, to: 20, above: 15, below: 0 });
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
    expect(listWindow(20, 10, 6)).toEqual({ start: 7, from: 8, to: 12, above: 8, below: 8 });
  });

  it("keeps about a third of the rows as margin, at least the ▲/▼ row", () => {
    expect([2, 3, 5, 6, 9, 10, 30].map(scrollMargin)).toEqual([0, 1, 1, 1, 2, 3, 9]);
  });

  it("scrolls down only once the selection reaches the lower third, and back up at the upper third", () => {
    // 9 rows: thirds of 3; the selection may reach the lower third's first row (row 6).
    let start = 0;
    const rows: number[] = [];
    for (let selected = 0; selected <= 15; selected++) {
      start = listWindow(30, selected, 9, start).start;
      rows.push(selected - start);
    }
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
    expect(start).toBe(9);
    const up: number[] = [];
    for (let selected = 14; selected >= 8; selected--) {
      start = listWindow(30, selected, 9, start).start;
      up.push(selected - start);
    }
    // Up through the middle without scrolling, then the upper third's last row (row 2) holds.
    expect(up).toEqual([5, 4, 3, 2, 2, 2, 2]);
  });

  it("reaches the first and last rows at the ends of the list", () => {
    expect(listWindow(30, 29, 9, 5)).toMatchObject({ start: 21, from: 22, to: 30, below: 0 });
    expect(listWindow(30, 0, 9, 15)).toMatchObject({ start: 0, from: 0, above: 0 });
  });

  it("scrolls only as far as needed for a jump, and keeps its place when the height changes", () => {
    // A jump down lands on the lower third's first row, a jump up on the upper third's last.
    expect(20 - listWindow(30, 20, 9, 0).start).toBe(6);
    expect(5 - listWindow(30, 5, 9, 15).start).toBe(2);
    // Taller: the top stays; shorter: it moves only to keep the margin.
    expect(listWindow(30, 10, 15, 5).start).toBe(5);
    expect(listWindow(30, 10, 6, 5).start).toBe(6);
  });
});

describe("nextWindow", () => {
  const at = (start: number, key: string, row: number, extra = {}) => ({ start, key, row, ...extra });

  it("centres a new list and after a change of `centre`", () => {
    expect(nextWindow(undefined, 30, 15, 9, "a").start).toBe(11);
    expect(nextWindow(at(0, "a", 0, { centre: false }), 30, 15, 9, "b", true).start).toBe(11);
  });

  it("keeps the selected entry on its screen row when entries come or go around it", () => {
    // Two entries added above it: it moved from row 10 to 12 and stays on screen row 4.
    expect(nextWindow(at(6, "a", 10), 30, 12, 9, "a").start).toBe(8);
  });

  it("leaves an entry picked with a click under the pointer, also in the margin", () => {
    expect(nextWindow(at(0, "a", 3, { clicked: "b" }), 30, 7, 9, "b").start).toBe(0);
    // Picked with a key instead, the list scrolls to keep the margin.
    expect(nextWindow(at(0, "a", 3), 30, 7, 9, "b").start).toBe(1);
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

describe("list order", () => {
  it("mirrors the keys of a list shown newest first", () => {
    const calls: string[] = [];
    const nav = { select: (d: number) => calls.push(`select ${d}`), first: () => calls.push("first"), last: () => calls.push("last") };
    const mirrored = orderedNav(true, nav);
    mirrored.select(1);
    mirrored.first();
    mirrored.last();
    orderedNav(false, nav).select(1);
    expect(calls).toEqual(["select -1", "last", "first", "select 1"]);
  });

  it("flips and names the order, highlighted when not the default", () => {
    expect(flipOrder("oldest-first")).toBe("newest-first");
    expect(orderFooter("newest-first", "oldest-first")).toMatchObject({ text: "s newest first", on: true });
    expect(orderFooter("newest-first", "newest-first")).toMatchObject({ on: false });
  });
});


describe("scrollPosition", () => {
  it("names the top and the end", () => {
    expect(scrollPosition(0, 260, 300, 40)).toBe("top");
    expect(scrollPosition(260, 260, 300, 40)).toBe("end");
  });

  it("lists the lines shown in between", () => {
    expect(scrollPosition(120, 260, 300, 40)).toBe("121–160/300");
  });

  it("says all when the content fits", () => {
    expect(scrollPosition(0, 0, 30, 40)).toBe("all");
  });
});

describe("tabAt", () => {
  it("finds the tab under a column of the top bar", () => {
    // "cco  1 Chat  2 Changes  3 Plan …"
    expect(tabAt(0, DEFAULT_SETTINGS, "chat")).toBeUndefined();
    expect(tabAt(4, DEFAULT_SETTINGS, "chat")).toBe("chat");
    expect(tabAt(11, DEFAULT_SETTINGS, "chat")).toBe("chat");
    expect(tabAt(12, DEFAULT_SETTINGS, "chat")).toBe("git");
    expect(tabAt(24, DEFAULT_SETTINGS, "chat")).toBe("plan");
    expect(tabAt(200, DEFAULT_SETTINGS, "chat")).toBeUndefined();
  });

  it("skips hidden views, unless it is the open one", () => {
    const settings = { ...DEFAULT_SETTINGS, viewGit: false };
    expect(tabAt(12, settings, "chat")).toBe("plan");
    expect(tabAt(12, settings, "git")).toBe("git");
  });
});
