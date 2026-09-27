import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTHOR, LICENSE, VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(AUTHOR).toBe(pkg.author);
    expect(LICENSE).toBe(pkg.license);
  });

  it("is the same in the lockfile and the plugin manifest", () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const lock = json("../package-lock.json");
    expect(lock.version).toBe(VERSION);
    expect(lock.packages[""].version).toBe(VERSION);
    expect(json("../plugin/.claude-plugin/plugin.json").version).toBe(VERSION);
  });
});
