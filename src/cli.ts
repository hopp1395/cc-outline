import { Command, Option } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { runHook } from "./hook.js";
import { openPane } from "./open.js";
import { App } from "./tui/App.js";
import type { Mode } from "./tui/layout.js";
import { registerViewer, unregisterViewer } from "./viewer.js";

const viewOption = () =>
  new Option("--view <view>", "view to start with").choices(["chat", "git"]).default("chat");

const program = new Command()
  .name("cco")
  .description("cc-outline: rendered session preview and git diff view")
  .version("0.1.0");

program
  .command("watch", { isDefault: true })
  .description("show the session of a project and follow new output")
  .option("--cwd <dir>", "project directory the Claude Code session runs in", process.cwd())
  .option("--session <id>", "show this session instead of the active one")
  .addOption(viewOption())
  .addOption(new Option("--unfocused", "the pane opens without the keyboard focus").hideHelp())
  .action(async (opts: { cwd: string; session?: string; view: Mode; unfocused?: boolean }) => {
    registerViewer(opts.cwd, opts.view);
    // Also covers exits that bypass Ink, e.g. the pane being closed.
    process.on("exit", () => unregisterViewer(opts.cwd));
    const app = render(
      createElement(App, {
        cwd: opts.cwd,
        sessionId: opts.session,
        initialMode: opts.view,
        unfocused: opts.unfocused,
      }),
      { alternateScreen: true, exitOnCtrlC: true },
    );
    await app.waitUntilExit();
    process.exit(0);
  });

program
  .command("hook")
  .description("Claude Code hook: record the active session (reads hook JSON from stdin)")
  .action(runHook);

program
  .command("open")
  .description("open the viewer in a split pane of the current terminal")
  .option("--cwd <dir>", "project directory", process.cwd())
  .addOption(viewOption())
  .action((opts: { cwd: string; view: Mode }) => {
    console.log(openPane(opts.cwd, opts.view));
  });

await program.parseAsync();
