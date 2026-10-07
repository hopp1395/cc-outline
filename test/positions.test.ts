import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_POSITIONS, readPositions, rememberScroll, savePositions } from "../src/positions.js";
import { positionsFile, writeJson } from "../src/transcript/locate.js";

const cwd = join(tmpdir(), "cco-positions-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-positions-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("positions", () => {
  it("starts empty", () => {
    expect(readPositions(cwd, "git")).toEqual({ selected: undefined, follow: undefined, scroll: {} });
  });

  it("keeps each list apart", () => {
    savePositions(cwd, "git", { selected: "src/a.cs", scroll: { "src/a.cs": 12, "src/a.cs#file": 40 } });
    savePositions(cwd, "plan", { selected: "toolu_1", follow: false, scroll: { toolu_1: 3 } });
    expect(readPositions(cwd, "git")).toMatchObject({ selected: "src/a.cs", scroll: { "src/a.cs": 12, "src/a.cs#file": 40 } });
    expect(readPositions(cwd, "plan")).toMatchObject({ selected: "toolu_1", follow: false, scroll: { toolu_1: 3 } });
  });

  it("keeps whether the pinned copy was selected", () => {
    savePositions(cwd, "chat", { selected: "a", follow: false, pinned: true, scroll: {} });
    expect(readPositions(cwd, "chat")).toMatchObject({ selected: "a", pinned: true });
    writeJson(positionsFile(cwd), { chat: { selected: "a", pinned: "yes", scroll: {} } });
    expect(readPositions(cwd, "chat").pinned).toBeUndefined();
  });

  it("ignores values of the wrong type", () => {
    writeJson(positionsFile(cwd), { chat: { selected: 5, follow: "no", scroll: { a: 3, b: "x", c: -1 } } });
    expect(readPositions(cwd, "chat")).toEqual({ selected: undefined, follow: undefined, scroll: { a: 3 } });
    writeFileSync(positionsFile(cwd), "not json");
    expect(readPositions(cwd, "chat").scroll).toEqual({});
  });

  it("drops the entries used longest ago", () => {
    const positions = { scroll: {} as Record<string, number> };
    for (let i = 0; i < MAX_POSITIONS + 5; i++) rememberScroll(positions, `k${i}`, i);
    // Using an old entry again moves it to the end.
    rememberScroll(positions, "k10", 99);
    rememberScroll(positions, "new", 1);
    const keys = Object.keys(positions.scroll);
    expect(keys).toHaveLength(MAX_POSITIONS);
    expect(keys).toContain("k10");
    expect(keys).not.toContain("k5");
    expect(keys.at(-1)).toBe("new");
  });
});
