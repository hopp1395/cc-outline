import { join } from "node:path";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/**
 * Where the plugin's launcher (`plugin/bin/cco.mjs`) finds this CLI. Calling
 * `cco` by name runs npm's shell script, whose helper programs (dirname, sed,
 * uname, cygpath) take seconds on Windows before node even starts.
 */
export function cliFile(): string {
  return join(claudeDir(), "cco", "cli.json");
}

/** The CLI as npm's shim starts it: in the global node_modules, which stays the same for `npm link` and `npm install -g`. */
const SHIM_PATH = /[\\/]node_modules[\\/]cc-outline[\\/]dist[\\/]cli\.js$/;

/** Records the path the CLI was started by, if npm's shim started it and it is not recorded yet. */
export function recordCli(started: string | undefined = process.argv[1]): void {
  if (!started || !SHIM_PATH.test(started)) return;
  if (readJson<{ cli?: string }>(cliFile())?.cli === started) return;
  try {
    writeJson(cliFile(), { cli: started });
  } catch {
    // The launcher then keeps going through the shim.
  }
}
