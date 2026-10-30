import { setupSteps } from "./accountSetup.js";
import { tilde } from "./doctor.js";
import { claudeDir } from "./transcript/locate.js";
import { installKind, packageRoot, remainingCommands, runCommand, runUpdate, type RunCommand } from "./update.js";
import { VERSION } from "./version.js";

export interface SetupOptions {
  /** The package folder of the running cco. */
  root?: string;
  run?: RunCommand;
  out?: (line: string) => void;
}

/** `cco setup`: installs (or enables) the plugin in this account. Returns the exit code. */
export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const root = options.root ?? packageRoot();
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const where = tilde(claudeDir());
  out(`cco setup · v${VERSION} · ${where}`);
  // The npx cache goes away: the plugin's hooks would run a cco that is no longer there.
  if (installKind(root) === "npx") {
    out("cco runs through npx. Install it first, then run cco setup again:");
    out("  npm install -g cc-outline");
    return 1;
  }
  const steps = setupSteps(root);
  if (steps.length === 0) {
    out(`The cco plugin is installed and enabled in ${where}.`);
    out("Restart Claude Code if it runs, then type /cco:chat.");
    return 0;
  }
  const printed = new Set<number>();
  const ok = await runUpdate(
    (results) => {
      for (const [i, r] of results.entries()) {
        if ((r.status !== "done" && r.status !== "failed") || printed.has(i)) continue;
        printed.add(i);
        out(`  ${r.status === "done" ? "✓" : "✗"} ${r.step.command}`);
        if (r.status === "failed") {
          for (const l of r.output.trim().split(/\r?\n/).slice(-12)) out(`      ${l}`);
          out("");
          out(`Run by hand: ${remainingCommands(results).join(" && ")}`);
        }
      }
    },
    options.run ?? runCommand,
    steps,
  );
  if (!ok) return 1;
  out("");
  out("Done. Restart Claude Code, then type /cco:chat.");
  return 0;
}
