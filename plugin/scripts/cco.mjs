// Starts the cco CLI in this node process. `cco` by name runs npm's shell
// script, whose helper programs (dirname, sed, uname, cygpath) take seconds
// on Windows; every /cco:… command and each prompt's hook waited for them.
// The CLI records its path in ~/.claude/cco/cli.json whenever the shim runs
// it; until then (or if that path is gone) this goes through the shim once.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function recordedCli() {
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cco", "cli.json");
    const { cli } = JSON.parse(readFileSync(file, "utf8"));
    return typeof cli === "string" && existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

const cli = recordedCli();
if (cli) {
  // The CLI parses process.argv from its third entry on, which are this script's arguments.
  await import(pathToFileURL(cli).href);
} else {
  const quoted = process.argv.slice(2).map((a) => `"${a.replace(/"/g, '\\"')}"`);
  const { status } = spawnSync(["cco", ...quoted].join(" "), { stdio: "inherit", shell: true });
  process.exitCode = status ?? 1;
}
