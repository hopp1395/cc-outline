import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** A fixed wait in a test: below this it is a pause for React to settle, above it the suite gets slower with each one. */
const MAX_FIXED_WAIT_MS = 150;

const testDir = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : testFiles(path);
    return /\.tsx?$/.test(entry.name) && path !== self ? [path] : [];
  });
}

/** The code lines of every test file, comments left out (a comment may name what the rules forbid). */
function codeLines(): { where: string; text: string }[] {
  return testFiles(testDir).flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .flatMap((text, i) => (/^\s*(\/\/|\/\*|\*)/.test(text) ? [] : [{ where: `${relative(testDir, file)}:${i + 1}`, text }])),
  );
}

describe("rules for tests", () => {
  it("wait no longer than a pause in fixed time: timers the viewer runs go through TIMING", () => {
    // setTimeout(resolve, 500), tick(500), wait(500): only plain numbers count, 3 * TIMING.blink follows the shortened timers.
    const fixed = /\b(?:setTimeout\([^;]*?,\s*|tick\(\s*)(\d[\d_]*)\s*\)/g;
    const slow = codeLines().flatMap(({ where, text }) =>
      [...text.matchAll(fixed)].filter((m) => Number(m[1].replaceAll("_", "")) > MAX_FIXED_WAIT_MS).map((m) => `${where}: ${m[0]}`),
    );
    expect(slow, `Fixed waits over ${MAX_FIXED_WAIT_MS} ms add up on every run. Wait for what the test needs (expect.poll, until, view.shown), or let the code read the delay from TIMING (src/timing.ts) and shorten it in test/setup.ts.`).toEqual([]);
  });

  it("do not use vi.mock: workers are shared, so a module another file loaded first stays unmocked", () => {
    const mocked = codeLines().flatMap(({ where, text }) => (/\bvi\.(?:mock|doMock)\(/.test(text) ? [`${where}: ${text.trim()}`] : []));
    expect(mocked, "Swap a fake into an object made for it (proc in src/proc.ts, clipboard, terminalFeatures, TIMING) in beforeAll and restore it in afterAll; see CLAUDE.md, Gotchas.").toEqual([]);
  });
});
