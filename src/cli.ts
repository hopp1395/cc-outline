import { Command, Option } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { runHook } from "./hook.js";
import { openPane } from "./open.js";
import { App } from "./tui/App.js";
import type { Mode } from "./tui/layout.js";
import { claudePidFromEnv } from "./transcript/locate.js";
import { VERSION } from "./version.js";
import { PLACEMENT_VALUES, type Placement } from "./settings.js";
import { isAlive, registerViewer, unregisterViewer } from "./viewer.js";

const VIEWS = ["chat", "git", "plan", "sessions", "settings"];

const pidOption = (flags: string, description: string) => new Option(flags, description).argParser(Number).hideHelp();
const validPid = (pid: number | undefined) => (pid && Number.isInteger(pid) ? pid : undefined);

/** Waits until process `pid` has exited, at most `timeoutMs`. */
async function waitForExit(pid: number, timeoutMs = 3000): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const start = Date.now(); isAlive(pid) && Date.now() - start < timeoutMs; ) await sleep(100);
  // Give the terminal a moment to close the pane or window, so the focus is back where the viewer was opened from.
  await sleep(300);
}

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
  .addOption(pidOption("--claude-pid <pid>", "follow the session of this Claude Code process"))
  // Where the pane was opened, so p in the viewer knows the current place.
  .addOption(new Option("--placement <placement>", "where the viewer runs").choices(PLACEMENT_VALUES).hideHelp())
  .action(async (opts: { cwd: string; session?: string; view?: Mode; unfocused?: boolean; claudePid?: number; placement?: Placement }) => {
    const claudePid = validPid(opts.claudePid);
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
        placement: opts.placement,
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
  .addOption(new Option("--placement <placement>", "where to open it (default: the session's placement, else the setting)").choices(PLACEMENT_VALUES))
  .addOption(pidOption("--claude-pid <pid>", "the Claude Code process the viewer belongs to (default: CLAUDE_PID)"))
  // Moving with p: the running viewer quits, and the new one opens once it is gone.
  .addOption(pidOption("--after-pid <pid>", "open once this viewer process has exited"))
  .action(async (opts: { cwd: string; view: Mode; placement?: Placement; claudePid?: number; afterPid?: number }) => {
    const afterPid = validPid(opts.afterPid);
    if (afterPid) await waitForExit(afterPid);
    const claudePid = validPid(opts.claudePid) ?? claudePidFromEnv();
    console.log(openPane(opts.cwd, opts.view, { claudePid, placement: opts.placement, replace: afterPid !== undefined }));
  });

await program.parseAsync();
