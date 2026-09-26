import { describe, expect, it } from "vitest";
import { sliceColumns, truncate, wrapPath } from "../src/tui/layout.js";

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
