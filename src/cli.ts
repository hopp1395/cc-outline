import { Command, Option } from "commander";
import { recordCli } from "./cliPath.js";
import { runHook } from "./hook.js";
import { openedFromQueue, openPane } from "./open.js";
import type { Mode } from "./tui/layout.js";
import { claudePidFromEnv, setClaudeDir } from "./transcript/locate.js";
import { VERSION } from "./version.js";
import { PLACEMENT_VALUES, type Placement } from "./settings.js";
import { isAlive, registerViewer, runningViewer, unregisterCurrentViewer, VIEWER_ACTIONS, type ViewerAction } from "./viewer.js";

const VIEWS = ["chat", "git", "plan", "sessions", "settings", "monitor", "accounts"];

const pidOption = (flags: string, description: string) => new Option(flags, description).argParser(Number).hideHelp();
const validPid = (pid: number | undefined) => (pid && Number.isInteger(pid) ? pid : undefined);

/**
 * Loads a module with React's production build. React picks its build from
 * `NODE_ENV` when it is first loaded, and its development build records every
 * render as a `performance.measure`, which Node keeps: a viewer whose spinner
 * ran all night had filled its 4 GB heap. `NODE_ENV` goes back afterwards,
 * so the programs the viewer starts (claude, npm) do not inherit it.
 */
async function importProduction<T>(load: () => Promise<T>): Promise<T> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    return await load();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

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
  .option("--session <id>", "show this session: its chat only, live while it runs, in a window of its own")
  // No default: without it, the session's last view (setting "view per session"), else the chat.
  .addOption(new Option("--view <view>", "view to start with (default: the session's last view, else chat)").choices(VIEWS))
  .addOption(new Option("--unfocused", "the pane opens without the keyboard focus").hideHelp())
  .addOption(pidOption("--claude-pid <pid>", "follow the session of this Claude Code process"))
  // Where the pane was opened, so p in the viewer knows the current place.
  .addOption(new Option("--placement <placement>", "where the viewer runs").choices(PLACEMENT_VALUES).hideHelp())
  .addOption(new Option("--select <entry>", "entry to select in the view (releases in settings)"))
  // After an update the viewer reopens and says so once.
  .addOption(new Option("--updated-to <version>").hideHelp())
  // /cco:update and /cco:account opening a new viewer: it checks and asks at once, or asks for the account.
  .addOption(new Option("--action <action>").choices(["update", "account"]).hideHelp())
  // The config folder (account) of the Claude Code that opened it: a terminal pane does not get its environment.
  .addOption(new Option("--config-dir <dir>").hideHelp())
  // A Remote Control session from claude.ai (Sessions: open it in a viewer of its own), in the chat only.
  .addOption(new Option("--remote <id>", "show this Remote Control session from claude.ai (experimental, setting remote API)"))
  // The window cco opened a session viewer in, so Sessions can bring it to the front.
  .addOption(new Option("--window <name>").hideHelp())
  .action(async (opts: { remote?: string; window?: string; cwd: string; session?: string; view?: Mode; unfocused?: boolean; claudePid?: number; placement?: Placement; select?: string; updatedTo?: string; action?: ViewerAction; configDir?: string }) => {
    // First: every state file and setting is read from the config folder.
    if (opts.configDir) setClaudeDir(opts.configDir);
    // A viewer of one session (--session, --remote): any number per session, registered for Sessions' ◎; it
    // belongs to no project's Claude Code here.
    if (opts.remote || opts.session) {
      const [{ registerSessionViewer }, { claudeDir }] = await Promise.all([import("./sessionViewers.js"), import("./transcript/locate.js")]);
      registerSessionViewer({ sessionId: opts.session, remoteId: opts.session ? undefined : opts.remote, configDir: claudeDir(), window: opts.window });
      const { runViewer } = await importProduction(() => import("./watch.js"));
      await runViewer({ cwd: opts.cwd, remoteId: opts.session ? undefined : opts.remote, sessionId: opts.session, initialMode: "chat" });
      process.exit(0);
    }
    const claudePid = validPid(opts.claudePid);
    // One viewer per Claude Code: a second one would share its state files and its /cco:… requests.
    const other = claudePid ? runningViewer(opts.cwd, claudePid) : undefined;
    if (other && other.pid !== process.pid) {
      console.error(`cco: a viewer (pid ${other.pid}) already runs for this Claude Code`);
      process.exit(1);
    }
    // The App records the view it actually starts in.
    registerViewer(opts.cwd, opts.view ?? "chat", claudePid);
    // Also covers exits that bypass Ink, e.g. the pane being closed.
    // Pairing (Sessions) moves the registration, so the current one is removed.
    process.on("exit", unregisterCurrentViewer);
    const { runViewer } = await importProduction(() => import("./watch.js"));
    await runViewer({
      cwd: opts.cwd,
      initialMode: opts.view,
      unfocused: opts.unfocused,
      claudePid,
      placement: opts.placement,
      select: opts.select,
      updatedTo: opts.updatedTo,
      action: opts.action,
    });
    process.exit(0);
  });

program
  .command("claude")
  .description("run claude under a config folder (account), then a shell there; for terminal windows cco opens")
  .requiredOption("--config-dir <dir>", "the config folder (CLAUDE_CONFIG_DIR)")
  .argument("[args...]", "arguments for claude")
  .action(async (args: string[], opts: { configDir: string }) => {
    const { runClaudeIn } = await import("./launch.js");
    process.exitCode = await runClaudeIn(opts.configDir, args);
  });

program
  .command("hook")
  .description("Claude Code hook: record the active session (reads hook JSON from stdin)")
  .action(runHook);

program
  .command("open")
  .description("open the viewer in a split pane of the current terminal")
  .option("--cwd <dir>", "project directory", process.cwd())
  // Without it, a running viewer keeps its view (--action restart); a new one opens in the chat, or with --action or --last-view in the session's last view.
  .addOption(new Option("--view <view>", "view to start with (default: chat)").choices(VIEWS))
  // /cco:open: back where the viewer was left.
  .addOption(new Option("--last-view", "start in the session's last view; a running viewer keeps its view").conflicts("view"))
  .addOption(new Option("--placement <placement>", "where to open it (default: the session's placement, else the setting)").choices(PLACEMENT_VALUES))
  .addOption(pidOption("--claude-pid <pid>", "the Claude Code process the viewer belongs to (default: CLAUDE_PID)"))
  // Moving with p: the running viewer quits, and the new one opens once it is gone.
  .addOption(pidOption("--after-pid <pid>", "open once this viewer process has exited"))
  .addOption(new Option("--select <entry>", "entry to select in the view (releases in settings)"))
  .addOption(new Option("--updated-to <version>").hideHelp())
  .addOption(new Option("--action <action>", "restart the running viewer (else open one), check for an update and offer it, or continue the session in another account").choices(VIEWER_ACTIONS))
  // A viewer that paired with a Claude Code it started (Sessions) moves next to it: its wt window or tmux pane.
  .addOption(new Option("--target <target>").hideHelp())
  .action(async (opts: { cwd: string; view?: Mode; lastView?: boolean; placement?: Placement; claudePid?: number; afterPid?: number; select?: string; updatedTo?: string; action?: ViewerAction; target?: string }) => {
    const afterPid = validPid(opts.afterPid);
    if (afterPid) await waitForExit(afterPid);
    const claudePid = validPid(opts.claudePid) ?? claudePidFromEnv();
    // Moving with p is not a command of Claude Code's.
    const queued = afterPid === undefined && openedFromQueue(opts.cwd, claudePid);
    const view = opts.view ?? (opts.action || opts.lastView ? undefined : "chat");
    console.log(openPane(opts.cwd, view, { claudePid, placement: opts.placement, replace: afterPid !== undefined, select: opts.select, updatedTo: opts.updatedTo, queued, action: opts.action, target: opts.target }));
  });

program
  .command("doctor")
  .description("check the installation, state files, settings, terminal and hooks; --fix repairs what it can")
  .option("--cwd <dir>", "project whose hooks are checked", process.cwd())
  .option("--fix", "repair without asking, then check again")
  .action(async (opts: { cwd: string; fix?: boolean }) => {
    // Loaded here only: the hook must start fast.
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor({ cwd: opts.cwd, fix: opts.fix });
  });

program
  .command("import")
  .description("import the session backups of a cco-session-export zip archive into the current folder (Sessions view: Enter, Export it)")
  .argument("<zip>", "the archive")
  .action(async (zip: string) => {
    // Loaded here only: the hook must start fast.
    const { importArchive, importSummary } = await import("./export/archive.js");
    try {
      const result = importArchive(zip, process.cwd());
      for (const s of result.imported) console.log(`imported  ${s.id}  ${s.title}${s.from ? ` (was ${s.from})` : ""}`);
      for (const s of result.skipped) console.log(`skipped   ${s.id}  ${s.title} (${s.reason})`);
      console.log(importSummary(result));
    } catch (err) {
      console.error(`cco: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// For the plugin's launcher, which starts this file without npm's shim.
recordCli();
await program.parseAsync();
