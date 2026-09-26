import { Command } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { runHook } from "./hook.js";
import { openPane } from "./open.js";
import { App } from "./tui/App.js";

const program = new Command()
  .name("ccmd")
  .description("Rendered Markdown preview of Claude Code sessions in a terminal pane")
  .version("0.1.0");

program
  .command("watch", { isDefault: true })
  .description("show the session of a project and follow new output")
  .option("--cwd <dir>", "project directory the Claude Code session runs in", process.cwd())
  .option("--session <id>", "show this session instead of the active one")
  .action(async (opts: { cwd: string; session?: string }) => {
    const app = render(createElement(App, { cwd: opts.cwd, sessionId: opts.session }), {
      alternateScreen: true,
      exitOnCtrlC: true,
    });
    await app.waitUntilExit();
  });

program
  .command("hook")
  .description("Claude Code hook: record the active session (reads hook JSON from stdin)")
  .action(runHook);

program
  .command("open")
  .description("open the viewer in a split pane of the current terminal")
  .option("--cwd <dir>", "project directory", process.cwd())
  .action((opts: { cwd: string }) => {
    console.log(openPane(opts.cwd));
  });

await program.parseAsync();
