import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No test reaches npm or GitHub: the viewer's update check finds nothing.
    setupFiles: ["test/setup.ts"],
    // The Ink tests poll for frames; the default 50 ms adds up over dozens of polls per test.
    expect: { poll: { interval: 10 } },
    // Each file in a fresh worker spent more time importing Ink, React and highlight.js than testing.
    // Shared workers need tests to leave no state behind: swap fakes into `proc`, `clipboard`, `TIMING`,
    // `terminalFeatures` and restore them, instead of vi.mock, which a shared module cache defeats.
    // Ink tests render once per key: 300-700 ms is work, not waiting. Slower is worth a look.
    slowTestThreshold: 1500,
    pool: "threads",
    isolate: false,
  },
});
