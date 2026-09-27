import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextMarked, readFavorites, toggleFavorite } from "../src/favorites.js";
import { favoritesFile } from "../src/transcript/locate.js";

const cwd = join(tmpdir(), "cco-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-favorites-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const stored = () => JSON.parse(readFileSync(favoritesFile(cwd), "utf8"));

describe("favorites", () => {
  it("starts empty", () => {
    expect(readFavorites(cwd, "turns")).toEqual([]);
  });

  it("keeps one list per kind", () => {
    expect(toggleFavorite(cwd, "turns", "a")).toEqual(["a"]);
    expect(toggleFavorite(cwd, "turns", "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(cwd, "files", "src/x.cs")).toEqual(["src/x.cs"]);
    expect(toggleFavorite(cwd, "plans", "toolu_1")).toEqual(["toolu_1"]);
    expect(toggleFavorite(cwd, "turns", "a")).toEqual(["b"]);
    expect(toggleFavorite(cwd, "days", "2026-09-27")).toEqual(["2026-09-27"]);
    expect(stored()).toEqual({ turns: ["b"], files: ["src/x.cs"], plans: ["toolu_1"], sessions: [], days: ["2026-09-27"] });
  });

  it("merges the earlier formats into the turns list", () => {
    mkdirSync(dirname(favoritesFile(cwd)), { recursive: true });
    writeFileSync(favoritesFile(cwd), JSON.stringify({ s1: ["a", "b"], s2: ["b", "c"] }));
    expect(readFavorites(cwd, "turns")).toEqual(["a", "b", "c"]);
    expect(readFavorites(cwd, "files")).toEqual([]);
    writeFileSync(favoritesFile(cwd), JSON.stringify({ turns: ["a"] }));
    expect(readFavorites(cwd, "turns")).toEqual(["a"]);
    expect(toggleFavorite(cwd, "files", "f")).toEqual(["f"]);
    expect(stored()).toEqual({ turns: ["a"], files: ["f"], plans: [], sessions: [], days: [] });
  });

  it("ignores broken files", () => {
    mkdirSync(dirname(favoritesFile(cwd)), { recursive: true });
    writeFileSync(favoritesFile(cwd), "{ not json");
    expect(readFavorites(cwd, "plans")).toEqual([]);
  });
});

describe("nextMarked", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("finds the next and previous marked entry", () => {
    expect(nextMarked(ids, ["b", "d"], 0, 1)).toBe(1);
    expect(nextMarked(ids, ["b", "d"], 1, 1)).toBe(3);
    expect(nextMarked(ids, ["b", "d"], 4, -1)).toBe(3);
    expect(nextMarked(ids, ["b", "d"], 3, -1)).toBe(1);
  });

  it("returns undefined past the last mark", () => {
    expect(nextMarked(ids, ["b"], 1, 1)).toBeUndefined();
    expect(nextMarked(ids, ["b"], 1, -1)).toBeUndefined();
    expect(nextMarked(ids, [], 2, 1)).toBeUndefined();
  });
});
