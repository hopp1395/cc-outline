import { Command, Option } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { runHook } from "./hook.js";
import { openPane } from "./open.js";
import { App } from "./tui/App.js";
import type { Mode } from "./tui/layout.js";
import { claudePidFromEnv } from "./transcript/locate.js";
import { VERSION } from "./version.js";
import { registerViewer, unregisterViewer } from "./viewer.js";

const VIEWS = ["chat", "git", "plan", "sessions", "settings"];

const program = new Command()
  .name("cco")
  .description("cc-outline: Claude Code session as Markdown, git diffs, plans and a session browser in a split pane")
  .version(VERSION);

program
  .command("watch", { isDefault: true })
  .description("show the session of a project and follow new output")
  .option("--cwd <dir>", "project directory the Claude Code session runs in", process.cwd())
  .option("--session <id>", "show this session instead of the active one")
  // No default: without it, the session's last view (setting "view per session"), else the chat.
  .addOption(new Option("--view <view>", "view to start with (default: the session's last view, else chat)").choices(VIEWS))
  .addOption(new Option("--unfocused", "the pane opens without the keyboard focus").hideHelp())
  .addOption(new Option("--claude-pid <pid>", "follow the session of this Claude Code process").argParser(Number).hideHelp())
  .action(async (opts: { cwd: string; session?: string; view?: Mode; unfocused?: boolean; claudePid?: number }) => {
    const claudePid = opts.claudePid && Number.isInteger(opts.claudePid) ? opts.claudePid : undefined;
    // The App records the view it actually starts in.
    registerViewer(opts.cwd, opts.view ?? "chat", claudePid);
    // Also covers exits that bypass Ink, e.g. the pane being closed.
    process.on("exit", () => unregisterViewer(opts.cwd, claudePid));
    const app = render(
      createElement(App, {
        cwd: opts.cwd,
        sessionId: opts.session,
        initialMode: opts.view,
        unfocused: opts.unfocused,
        claudePid,
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
  .addOption(new Option("--view <view>", "view to start with").choices(VIEWS).default("chat"))
  .action((opts: { cwd: string; view: Mode }) => {
    console.log(openPane(opts.cwd, opts.view, { claudePid: claudePidFromEnv() }));
  });

await program.parseAsync();
