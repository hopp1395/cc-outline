import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
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

describe("favorites", () => {
  it("starts empty", () => {
    expect(readFavorites(cwd, "s1")).toEqual([]);
  });

  it("marks and unmarks turns per session", () => {
    expect(toggleFavorite(cwd, "s1", "a")).toEqual(["a"]);
    expect(toggleFavorite(cwd, "s1", "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(cwd, "s2", "c")).toEqual(["c"]);
    expect(toggleFavorite(cwd, "s1", "a")).toEqual(["b"]);
    expect(readFavorites(cwd, "s1")).toEqual(["b"]);
    expect(readFavorites(cwd, "s2")).toEqual(["c"]);
  });

  it("drops a session without marks from the file", () => {
    toggleFavorite(cwd, "s1", "a");
    toggleFavorite(cwd, "s1", "a");
    expect(JSON.parse(readFileSync(favoritesFile(cwd), "utf8"))).toEqual({});
  });
});
