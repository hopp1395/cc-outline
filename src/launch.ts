import { spawn } from "node:child_process";
import { independentEnv } from "./open.js";
import { withClaudeDir } from "./transcript/locate.js";

/**
 * `cco claude`: runs `claude <args>` under the config folder `dir` (an account), then an interactive shell in
 * the same folder, so the window stays open as `cmd /k` kept it. Windows Terminal starts a new tab or pane with
 * its own environment, not that of the `wt` call, so CLAUDE_CONFIG_DIR cannot be handed over that way.
 */
export async function runClaudeIn(dir: string, args: string[]): Promise<number> {
  const env = withClaudeDir(independentEnv(), dir);
  const run = (command: string, argv: string[], shell: boolean) =>
    new Promise<number>((resolve) => {
      // Through the shell on Windows: claude may be an npm .cmd shim, which Node starts only that way.
      const child = spawn(command, argv, { stdio: "inherit", env, shell });
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    });
  await run("claude", args, process.platform === "win32");
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "sh";
  return run(shell, [], false);
}
