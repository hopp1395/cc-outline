import { defineConfig } from "tsup";

export default defineConfig({
  // The status line is an entry of its own: Claude Code runs it after every message, and the CLI's imports are slow to load.
  entry: ["src/cli.ts", "src/statusline.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
