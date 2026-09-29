import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No test reaches npm or GitHub: the viewer's update check finds nothing.
    setupFiles: ["test/setup.ts"],
  },
});
