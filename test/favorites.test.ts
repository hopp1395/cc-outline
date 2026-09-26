import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(readFavorites(cwd)).toEqual([]);
  });

  it("marks and unmarks turns of the project", () => {
    expect(toggleFavorite(cwd, "a")).toEqual(["a"]);
    expect(toggleFavorite(cwd, "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(cwd, "a")).toEqual(["b"]);
    expect(readFavorites(cwd)).toEqual(["b"]);
    expect(JSON.parse(readFileSync(favoritesFile(cwd), "utf8"))).toEqual({ turns: ["b"] });
  });

  it("merges the earlier per-session format", () => {
    mkdirSync(dirname(favoritesFile(cwd)), { recursive: true });
    writeFileSync(favoritesFile(cwd), JSON.stringify({ s1: ["a", "b"], s2: ["b", "c"] }));
    expect(readFavorites(cwd)).toEqual(["a", "b", "c"]);
    expect(toggleFavorite(cwd, "a")).toEqual(["b", "c"]);
    expect(JSON.parse(readFileSync(favoritesFile(cwd), "utf8"))).toEqual({ turns: ["b", "c"] });
  });

  it("ignores broken files", () => {
    mkdirSync(dirname(favoritesFile(cwd)), { recursive: true });
    writeFileSync(favoritesFile(cwd), "{ not json");
    expect(readFavorites(cwd)).toEqual([]);
  });
});
