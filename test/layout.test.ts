import { describe, expect, it } from "vitest";
import { fitFooter, sliceColumns, truncate, wrapPath, type FooterItem } from "../src/tui/layout.js";

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
