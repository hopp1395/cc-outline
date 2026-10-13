import { spawn } from "node:child_process";
import { independentEnv } from "./open.js";
import { withClaudeDir } from "./transcript/locate.js";

/** Characters that end an argument or mean something to cmd.exe, so an argument holding one is quoted. */
const CMD_SPECIAL = /[\s"&|<>^()%!,;=]/;

/**
 * The command line that runs `claude <args>` through cmd.exe: one string, each argument quoted where needed
 * (a `"` inside doubled). Node warns (DEP0190) when `shell: true` gets the arguments as a list, which it only
 * joins with spaces.
 */
export function claudeCommandLine(args: string[]): string {
  const quote = (arg: string) => (arg === "" ? '""' : CMD_SPECIAL.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
  return ["claude", ...args.map(quote)].join(" ");
}

/** The shell that keeps the window open after claude: cmd.exe with `/k`, which leaves out its banner. */
export function shellAfter(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (platform === "win32") return { command: env.ComSpec || "cmd.exe", args: ["/k"] };
  return { command: env.SHELL || "sh", args: [] };
}

/**
 * `cco claude`: runs `claude <args>` under the config folder `dir` (an account), then an interactive shell in
 * the same folder, so the window stays open as `cmd /k` kept it. Windows Terminal starts a new tab or pane with
 * its own environment, not that of the `wt` call, so CLAUDE_CONFIG_DIR cannot be handed over that way.
 */
export async function runClaudeIn(dir: string, args: string[]): Promise<number> {
  const env = withClaudeDir(independentEnv(), dir);
  const run = (child: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    });
  // Through the shell on Windows: claude may be an npm .cmd shim, which Node starts only that way.
  await run(
    process.platform === "win32" ? spawn(claudeCommandLine(args), { stdio: "inherit", env, shell: true }) : spawn("claude", args, { stdio: "inherit", env }),
  );
  const shell = shellAfter();
  return run(spawn(shell.command, shell.args, { stdio: "inherit", env }));
}
