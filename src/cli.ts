import { Command, Option } from "commander";
import { recordCli } from "./cliPath.js";
import { runHook } from "./hook.js";
import { openedFromQueue, openPane } from "./open.js";
import type { Mode } from "./tui/layout.js";
import { claudePidFromEnv, setClaudeDir } from "./transcript/locate.js";
import { VERSION } from "./version.js";
import { PLACEMENT_VALUES, readSettings, type Placement } from "./settings.js";
import { applyLanguage, L } from "./i18n/index.js";
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

// The help and the messages in the language of the settings; the hook prints nothing and stays fast without it.
const t = (() => {
  if (process.argv[2] !== "hook") applyLanguage(readSettings().language);
  return L().cli;
})();

const program = new Command()
  .name("cco")
  .description(t.description)
  .version(VERSION, "-V, --version", t.version)
  .helpOption("-h, --help", t.help)
  .helpCommand("help [command]", t.helpCommand);

program
  .command("watch", { isDefault: true })
  .description(t.watch)
  .option("--cwd <dir>", t.cwd, process.cwd())
  .option("--session <id>", t.session)
  // No default: without it, the session's last view (setting "view per session"), else the chat.
  .addOption(new Option("--view <view>", t.view).choices(VIEWS))
  .addOption(new Option("--unfocused", t.unfocused).hideHelp())
  .addOption(pidOption("--claude-pid <pid>", t.claudePid))
  // Where the pane was opened, so p in the viewer knows the current place.
  .addOption(new Option("--placement <placement>", t.placement).choices(PLACEMENT_VALUES).hideHelp())
  .addOption(new Option("--select <entry>", t.select))
  // After an update the viewer reopens and says so once.
  .addOption(new Option("--updated-to <version>").hideHelp())
  // /cco:update and /cco:account opening a new viewer: it checks and asks at once, or asks for the account.
  .addOption(new Option("--action <action>").choices(["update", "account"]).hideHelp())
  // The config folder (account) of the Claude Code that opened it: a terminal pane does not get its environment.
  .addOption(new Option("--config-dir <dir>").hideHelp())
  // A Remote Control session from claude.ai (Sessions: open it in its own viewer), in the chat only.
  .addOption(new Option("--remote <id>", t.remote))
  .addOption(new Option("--observe", t.observe))
  // The window cco opened an observer in, so Sessions can bring it to the front.
  .addOption(new Option("--window <name>").hideHelp())
  .action(async (opts: { remote?: string; observe?: boolean; window?: string; cwd: string; session?: string; view?: Mode; unfocused?: boolean; claudePid?: number; placement?: Placement; select?: string; updatedTo?: string; action?: ViewerAction; configDir?: string }) => {
    // First: every state file and setting is read from the config folder.
    if (opts.configDir) {
      setClaudeDir(opts.configDir);
      applyLanguage(readSettings().language);
    }
    // An observer (--session, --remote --observe): any number per session, registered for Sessions' ◎.
    const observe = opts.session !== undefined || (opts.remote !== undefined && opts.observe === true);
    if (observe) {
      const [{ registerObserver }, { claudeDir }] = await Promise.all([import("./observers.js"), import("./transcript/locate.js")]);
      registerObserver({ sessionId: opts.session, remoteId: opts.session ? undefined : opts.remote, configDir: claudeDir(), window: opts.window });
    }
    if (opts.remote || opts.session) {
      // A steering remote viewer is one per session; neither kind belongs to a project's Claude Code here.
      if (!observe) {
        const { registerRemoteViewer } = await import("./remote/viewer.js");
        registerRemoteViewer(opts.remote!);
      }
      const { runViewer } = await importProduction(() => import("./watch.js"));
      await runViewer({ cwd: opts.cwd, remoteId: opts.session ? undefined : opts.remote, sessionId: opts.session, observe, initialMode: "chat" });
      process.exit(0);
    }
    const claudePid = validPid(opts.claudePid);
    // One viewer per Claude Code: a second one would share its state files and its /cco:… requests.
    const other = claudePid ? runningViewer(opts.cwd, claudePid) : undefined;
    if (other && other.pid !== process.pid) {
      console.error(t.otherViewer(other.pid));
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
  .description(t.claude)
  .requiredOption("--config-dir <dir>", t.configDir)
  .argument("[args...]", t.claudeArgs)
  .action(async (args: string[], opts: { configDir: string }) => {
    const { runClaudeIn } = await import("./launch.js");
    process.exitCode = await runClaudeIn(opts.configDir, args);
  });

program
  .command("hook")
  .description(t.hook)
  .action(runHook);

program
  .command("open")
  .description(t.open)
  .option("--cwd <dir>", t.openCwd, process.cwd())
  // Without it, a running viewer keeps its view (--action restart); a new one opens in the chat, or with --action or --last-view in the session's last view.
  .addOption(new Option("--view <view>", t.openView).choices(VIEWS))
  // /cco:open: back where the viewer was left.
  .addOption(new Option("--last-view", t.lastView).conflicts("view"))
  .addOption(new Option("--placement <placement>", t.openPlacement).choices(PLACEMENT_VALUES))
  .addOption(pidOption("--claude-pid <pid>", t.openClaudePid))
  // Moving with p: the running viewer quits, and the new one opens once it is gone.
  .addOption(pidOption("--after-pid <pid>", t.afterPid))
  .addOption(new Option("--select <entry>", t.select))
  .addOption(new Option("--updated-to <version>").hideHelp())
  .addOption(new Option("--action <action>", t.action).choices(VIEWER_ACTIONS))
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
  .description(t.doctor)
  .option("--cwd <dir>", t.doctorCwd, process.cwd())
  .option("--fix", t.fix)
  .action(async (opts: { cwd: string; fix?: boolean }) => {
    // Loaded here only: the hook must start fast.
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor({ cwd: opts.cwd, fix: opts.fix });
  });

program
  .command("import")
  .description(t.import)
  .argument("<zip>", t.zip)
  .action(async (zip: string) => {
    // Loaded here only: the hook must start fast.
    const { importArchive, importSummary } = await import("./export/archive.js");
    try {
      const result = importArchive(zip, process.cwd());
      for (const s of result.imported) console.log(t.imported(s.id, s.title, s.from));
      for (const s of result.skipped) console.log(t.skipped(s.id, s.title, s.reason));
      console.log(importSummary(result));
    } catch (err) {
      console.error(`cco: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// For the plugin's launcher, which starts this file without npm's shim.
recordCli();
await program.parseAsync();
