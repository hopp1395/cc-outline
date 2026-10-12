import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Account } from "../account.js";
import { continueInAccount, matchAccount, otherAccounts, type ContinuePlan } from "../accountContinue.js";
import { pluginSteps } from "../accountSetup.js";
import { detectTerminal, openInDefaultApp, resumeForPairing, resumeInNewWindow, resumeShellCommand } from "../open.js";
import { prepareConsoleInput, type ConsoleTyper } from "../switchSession.js";
import { TIMING } from "../timing.js";
import { inClaudeDir, projectSlug } from "../transcript/locate.js";
import { SessionReader, type SessionSummary } from "../transcript/sessions.js";
import { predecessors } from "../transcript/continuation.js";
import { runningSessions, type RunningSession } from "../transcript/trash.js";
import { remainingCommands, type StepResult } from "../update.js";
import { cancelPairing, requestPairing, type PairTarget } from "../viewer.js";
import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { truncate, type Layout } from "./layout.js";
import { currentStep, failureLines, useProgress, type Progress } from "./ProgressDialog.js";
import { useAccountState } from "./useAccount.js";
import { useClipboard } from "./useClipboard.js";
import { useSetting } from "./useSetting.js";
import { accountBar, HEAD_WIDTH, sessionHead, sessionTitle, tilde, type HeadContext } from "./sessionHead.js";

/** How long a viewer waits for the Claude Code it started to show up, before it stays unpaired. */
export const PAIR_TIMEOUT_MS = 30_000;

export { sessionTitle };

/** The wait for a started Claude Code to pair with. */
export interface Pairing {
  sessionId: string;
  cwd: string;
  transcript: string;
  /** The config folder it was started under, when another account's (a session continued there). */
  configDir?: string;
  /** It was started as a new session (`--session-id`), not continued. */
  fresh?: boolean;
  /** The dialog's title; by default `Attach the viewer`. */
  title?: string;
  /** Where it runs: a Windows Terminal window name or a tmux pane id; not yet known while it is being started. */
  where?: string;
  /** Epoch ms. */
  started: number;
  /** It did not start or show up in time: what the dialog says until Esc. */
  failed?: { text: string; lines: string[] };
}

/** The pairing's progress dialog: starting Claude Code, waiting for it (Esc cancels), or why it failed. */
export function pairingProgress(pairing: Pairing, now: number, onCancel: () => void, onClose: () => void, copyCommand?: () => void): Progress {
  const title = pairing.title ?? "Attach the viewer";
  if (pairing.failed) return { title, status: "failed", ...pairing.failed, onClose, ...(copyCommand ? { copy: copyCommand } : {}) };
  if (pairing.where === undefined) return { title, status: "running", text: "Starting Claude Code", onCancel };
  const total = PAIR_TIMEOUT_MS / 1000;
  const waited = Math.min(total, Math.floor((now - pairing.started) / 1000));
  return { title, status: "running", text: "Waiting for Claude Code", detail: `${waited} of ${total} s · the viewer moves next to it once it runs`, onCancel };
}

const progressSteps = (steps: StepResult[]) => steps.map((r) => ({ label: r.step.label, status: r.status, output: r.output }));

/** Continuing a session in another account (or preparing it for a new one), until its Claude Code starts there. */
export function continueProgress(account: Account, steps: StepResult[], session: string, title = `Continue in ${account.email}`): Progress {
  const step = currentStep(progressSteps(steps));
  const verb = step?.label === "closing Claude Code" ? "Closing" : step?.label === "copying the session" ? "Copying" : "Installing the cco plugin";
  return { title, status: "running", text: verb, step, detail: session };
}

/** The viewer's own session, for continuing it in another account from a list of accounts. */
export interface OwnSession {
  summary: SessionSummary;
  /** The Claude Code it runs in, if it runs. */
  claude?: RunningSession;
  /** The folder it ran in. */
  dir: string;
}

/** Reads the session of transcript `path` (and the ones it continued from) for continuing it elsewhere. */
export function ownSession(path: string, cwd: string): OwnSession {
  const summary: SessionSummary = { ...new SessionReader(path).update(), continues: predecessors(path).map((f) => basename(f, ".jsonl")) };
  return { summary, claude: runningSessions().get(summary.id), dir: summary.cwd ?? cwd };
}

interface Options {
  layout: Layout;
  /** The Claude Code process the viewer belongs to: closing it must not close the viewer. */
  claudePid?: number;
  /** A Claude Code the viewer started runs now `where`: the viewer moves next to it, paired. */
  onPairStarted?: (target: PairTarget, where: string) => void;
  /** While true, the viewer stays open when its Claude Code ends (it is closed on purpose). */
  onHoldOpen?: (hold: boolean) => void;
  /** A short message in the help line. */
  notify: (message: string) => void;
  /** A session was copied into another account (the Sessions view reads its list again). */
  onCopied?: () => void;
}

/**
 * Continuing a session in another account, starting a new one there, and attaching the viewer to a Claude Code
 * it started: the dialogs, the progress and the wait, for the Sessions, Accounts and Settings views. `element`
 * renders the dialogs; `open` is true while one of them, the progress or the wait is up.
 */
export function useAccountFlow({ layout, claudePid, onPairStarted, onHoldOpen, notify, onCopied }: Options) {
  const accountState = useAccountState();
  const others = otherAccounts(accountState.accounts);
  const copy = useClipboard();
  const [choice, setChoice] = useState<Choice>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [run, setRun] = useState<Progress>();
  const [pairing, setPairing] = useState<Pairing>();
  const [, setPairTick] = useState(0);
  const fromEmail = accountState.current?.email;
  const [accountColor] = useSetting("accountColor");
  const ctx: HeadContext = { accounts: accountState, accountColor };
  /** The head of the dialogs about `s`: where it runs is the viewer's own Claude Code, another, or none. */
  const headOf = (s: SessionSummary, claude: RunningSession | undefined, dir: string) =>
    sessionHead(s, ctx, { dir, gone: !existsSync(dir), state: claude ? (claude.pid === claudePid ? "current" : "active") : "inactive" });

  // The PowerShell started to type /exit, until it is used or the dialog closes.
  const typer = useRef<ConsoleTyper>(undefined);
  const takeTyper = () => {
    const prepared = typer.current;
    typer.current = undefined;
    return prepared;
  };
  const closeChoice = () => {
    takeTyper()?.cancel();
    setChoice(undefined);
  };
  useEffect(() => () => takeTyper()?.cancel(), []);

  /**
   * Starts a session in a new window, where Claude Code's hook leaves opening a viewer to this one, then waits for it.
   * `account`: under another account's config folder, whose hook reads the request there. `fresh`: a new session
   * under the id `s.id` (`--session-id`), not one to continue.
   */
  const startPairing = async (s: Pick<SessionSummary, "id" | "path">, title: string, dir: string, account?: { dir: string; title: string }, fresh = false) => {
    const inAccount = <T,>(fn: () => T) => (account ? inClaudeDir(account.dir, fn) : fn());
    inAccount(() => requestPairing(dir, s.id, Date.now() + 2 * PAIR_TIMEOUT_MS));
    // Waiting from now on, so a second Enter starts nothing more.
    const started: Pairing = { sessionId: s.id, cwd: dir, transcript: s.path, configDir: account?.dir, fresh, title: account?.title, started: Date.now() };
    setPairing(started);
    const { message, target } = await resumeForPairing(s.id, dir, truncate(title, 30), account?.dir, fresh);
    if (!target) {
      inAccount(() => cancelPairing(dir, s.id));
      return setPairing((p) => (p === started ? { ...started, failed: { text: "Claude Code did not start", lines: [message] } } : p));
    }
    setPairing((p) => (p === started ? { ...started, where: target } : p));
  };
  /** Withdraws the pairing's request, in the account it was made in. */
  const withdraw = (p: Pairing) => (p.configDir ? inClaudeDir(p.configDir, () => cancelPairing(p.cwd, p.sessionId)) : cancelPairing(p.cwd, p.sessionId));
  /** Esc while it waits: the request is withdrawn; the Claude Code started keeps running. */
  const cancelWait = () => {
    if (pairing) withdraw(pairing);
    setPairing(undefined);
    onHoldOpen?.(false);
    notify("pairing cancelled; Claude Code keeps running in its window");
  };
  // Waiting: pairs once the session's Claude Code registers itself, gives up after PAIR_TIMEOUT_MS.
  useEffect(() => {
    if (!pairing || pairing.failed) return;
    const timer = setInterval(() => {
      // A Claude Code of another account registers in that account's folder.
      const read = () => (pairing.configDir ? inClaudeDir(pairing.configDir, runningSessions) : runningSessions());
      const claude = pairing.where !== undefined ? read().get(pairing.sessionId) : undefined;
      if (claude && pairing.where !== undefined) {
        clearInterval(timer);
        setPairing(undefined);
        // The request stays for its hook, which may be still to come; it expires by itself.
        const target: PairTarget = { cwd: pairing.cwd, claudePid: claude.pid, sessionId: pairing.sessionId, transcript: pairing.transcript, configDir: pairing.configDir };
        return onPairStarted?.(target, pairing.where);
      }
      if (Date.now() - pairing.started >= PAIR_TIMEOUT_MS) {
        clearInterval(timer);
        withdraw(pairing);
        const failed = {
          text: `Claude Code did not show up within ${PAIR_TIMEOUT_MS / 1000} s`,
          lines: ["The viewer stays as it was; the Claude Code started keeps running in its window."],
        };
        return setPairing((p) => (p === pairing ? { ...pairing, failed } : p));
      }
      setPairTick((n) => n + 1);
    }, TIMING.pairPoll);
    return () => clearInterval(timer);
  }, [pairing]);
  // Without a terminal to start it in, the command that starts it in the other account is what is left.
  const pairingCommand = pairing?.configDir ? resumeShellCommand(pairing.sessionId, pairing.configDir, process.platform, pairing.fresh) : undefined;
  useProgress(
    pairing
      ? pairingProgress(
          pairing,
          Date.now(),
          cancelWait,
          () => {
            setPairing(undefined);
            onHoldOpen?.(false);
          },
          pairingCommand ? () => void copy(pairingCommand).then(() => notify(`copied: ${pairingCommand}`)) : undefined,
        )
      : run && {
          ...run,
          onClose: () => {
            setRun(undefined);
            run.onClose?.();
          },
        },
  );

  /**
   * Continue in another account: which one (the only other one at once; `query` of /cco:account picks one),
   * then how (`askHow`).
   */
  const askAccount = (s: SessionSummary, claude: RunningSession | undefined, dir: string, query?: string) => {
    if (others.length === 0) return notify("no other Claude account is signed in here");
    const named = query ? matchAccount(others, query) : undefined;
    if (query && !named) notify(`no other account matches “${query}”`);
    const only = named ?? (others.length === 1 ? others[0] : undefined);
    if (only) return askHow(s, only, claude, dir);
    setChoice({
      title: "Continue in which account?",
      lines: headOf(s, claude, dir),
      options: others.map((a) => ({
        id: a.dir,
        label: a.email,
        detail: truncate(`${tilde(a.dir)}${pluginSteps(a.dir).length ? " · gets the cco plugin" : ""}`, 56),
      })),
      initial: 0,
      onChoose: (id) => {
        setChoice(undefined);
        const account = others.find((a) => a.dir === id);
        if (account) askHow(s, account, claude, dir);
      },
    });
  };

  /** What continuing `s` in `account` does, asked before it starts: for a running session also whether to close it. */
  const askHow = (s: SessionSummary, account: Account, claude: RunningSession | undefined, dir: string) => {
    const plugin = pluginSteps(account.dir);
    const lines = [
      ...headOf(s, claude, dir),
      "",
      truncate(`A copy continues in ${account.email}`, HEAD_WIDTH),
      `in a new window${plugin.length ? ", with the cco plugin installed there first" : ""}; this one stays.`,
    ];
    const plan = (close?: ContinuePlan["close"]): ContinuePlan => ({ session: s, account, fromEmail, close });
    if (!claude) {
      return setConfirmation({ title: `Continue in ${truncate(account.email, 44)}?`, lines, onConfirm: () => void runContinue(plan(), dir) });
    }
    const busy = claude.activity === "busy" || claude.activity === "waiting" ? `Claude is ${claude.activity === "busy" ? "working" : "waiting for an answer"}; close it once it is idle` : undefined;
    const closeBlocked = claude.kind === "bg" ? "it runs in the background: there is no console to type /exit into" : busy;
    // On Windows, PowerShell takes a second or more to start: it does so while the dialog is open.
    if (!closeBlocked && detectTerminal() !== "tmux") typer.current = prepareConsoleInput(claude.pid);
    setChoice({
      title: `Continue in ${truncate(account.email, 44)}?`,
      lines,
      options: [
        { id: "close", label: "Close it and continue there", detail: "/exit is typed into its Claude Code; the copy starts after", disabled: closeBlocked },
        { id: "keep", label: "Continue there, keep it running", detail: "the two go on apart from here" },
      ],
      initial: closeBlocked ? 1 : 0,
      onChoose: (id) => {
        const prepared = takeTyper();
        if (id !== "close") prepared?.cancel();
        setChoice(undefined);
        void runContinue(plan(id === "close" ? { pid: claude.pid, typer: prepared } : undefined), dir);
      },
    });
  };

  /** The plugin could not be installed: says why, and on Esc asks whether to go on without it. */
  const pluginFailed = (steps: StepResult[], title: string, head: string[], goOn: () => void) => {
    // Only the plugin's commands; closing and copying run here.
    const commands = remainingCommands(steps).filter((c) => c.startsWith("claude "));
    setRun({
      title,
      status: "failed",
      text: "The cco plugin could not be installed there",
      lines: [...failureLines(progressSteps(steps)), "Nothing else has happened. Esc: go on without it, or stop."],
      copy: () => void copy(commands.join("\n")).then(() => notify("copied the commands")),
      onClose: () =>
        setChoice({
          title: "Go on without the cco plugin?",
          lines: head,
          options: [
            { id: "go", label: "Go on without it", detail: "the viewer there does not follow /clear, /resume or the end" },
            { id: "stop", label: "Stop here", detail: "nothing has changed" },
          ],
          initial: 0,
          onChoose: (id) => {
            setChoice(undefined);
            if (id === "go") goOn();
          },
        }),
    });
  };

  /** Runs the steps up to the copy in the progress dialog, then starts the copy in the other account and attaches to it. */
  const runContinue = async (plan: ContinuePlan, dir: string) => {
    const { account } = plan;
    const s = plan.session!;
    const title = `Continue in ${account.email}`;
    const name = truncate(sessionTitle(s), 40);
    // Closing the viewer's own Claude Code must not close the viewer.
    const own = plan.close !== undefined && plan.close.pid === claudePid;
    if (own) onHoldOpen?.(true);
    const result = await continueInAccount(plan, (steps) => setRun(continueProgress(account, steps, name)));
    if (result.kind === "plugin-failed") {
      plan.close?.typer?.cancel();
      if (own) onHoldOpen?.(false);
      return pluginFailed(result.steps, title, [...headOf(s, undefined, dir).slice(0, -1), truncate(`to continue in ${account.email}`, HEAD_WIDTH)], () =>
        void runContinue({ ...plan, skipPlugin: true, close: plan.close && { pid: plan.close.pid } }, dir),
      );
    }
    if (result.kind === "failed") {
      if (own) onHoldOpen?.(false);
      return setRun({ title, status: "failed", text: "The session was not continued there", lines: [result.message] });
    }
    setRun(undefined);
    onCopied?.();
    if (result.copy) void startPairing({ id: result.copy.id, path: result.copy.path }, sessionTitle(s), dir, { dir: account.dir, title });
  };

  /**
   * Starts a new session in `account`, in the folder `dir`, in a new window: with `attach` the viewer moves next to
   * it, into that account. The cco plugin is installed there first if it lacks it.
   */
  const startNew = async (account: Account, dir: string, attach: boolean, skipPlugin = false) => {
    const title = `New session in ${account.email}`;
    const result = await continueInAccount({ account, fromEmail, skipPlugin }, (steps) => setRun(continueProgress(account, steps, tilde(dir), title)));
    if (result.kind === "plugin-failed")
      return pluginFailed(result.steps, title, [truncate(`a new session in ${account.email}`, HEAD_WIDTH), truncate(`in ${tilde(dir)}`, HEAD_WIDTH)], () => void startNew(account, dir, attach, true));
    if (result.kind === "failed") return setRun({ title, status: "failed", text: "No session was started", lines: [result.message] });
    setRun(undefined);
    const id = randomUUID();
    if (attach) return void startPairing({ id, path: join(account.dir, "projects", projectSlug(dir), `${id}.jsonl`) }, "new session", dir, { dir: account.dir, title }, true);
    if (!detectTerminal()) {
      const command = resumeShellCommand(id, account.dir, process.platform, true);
      return setRun({
        title,
        status: "done",
        text: "Start it by hand",
        lines: ["No Windows Terminal or tmux to open a window in. Run in a terminal:", `  ${command}`, `in ${tilde(dir)}`],
        copy: () => void copy(command).then(() => notify(`copied: ${command}`)),
      });
    }
    notify(resumeInNewWindow(id, dir, "new session", "new", account.dir, true));
  };

  /**
   * What can be done with `account` (Accounts view, Settings): continue the viewer's session there (`own`; else
   * greyed out with `noSession`), start a new session there with or without the viewer, open its config folder.
   */
  const accountMenu = (account: Account, cwd: string, own: OwnSession | undefined, noSession?: string) => {
    const active = account.dir === accountState.current?.dir;
    const plugin = pluginSteps(account.dir).length > 0 ? " · gets the cco plugin" : "";
    setChoice({
      title: `What to do in ${truncate(account.email, 40)}?`,
      lines: [
        `${accountBar(account, accountState, accountColor)} ${truncate(`${account.email} · ${tilde(account.dir)}`, HEAD_WIDTH - 2)}`,
        active ? "the account of the Claude Code this viewer follows" : "another account",
        ...(own ? ["", ...headOf(own.summary, own.claude, own.dir)] : []),
      ],
      options: [
        {
          id: "continue",
          label: truncate(`Continue it in ${account.email}…`, HEAD_WIDTH - 4),
          detail: `a copy, in a new window${plugin}`,
          disabled: active ? "it is this session's account" : own ? undefined : (noSession ?? "there is no session to continue"),
        },
        { id: "new", label: "Start a new session there", detail: truncate(`in ${tilde(cwd)}, in a new window${plugin}`, HEAD_WIDTH) },
        { id: "new-attach", label: "Start a new session and attach the viewer", detail: "the viewer moves next to it, into that account" },
        { id: "folder", label: "Open its config folder", detail: truncate(tilde(account.dir), HEAD_WIDTH) },
      ],
      initial: !active && own ? 0 : 1,
      onChoose: (id) => {
        setChoice(undefined);
        if (id === "continue" && own) return askHow(own.summary, account, own.claude, own.dir);
        if (id === "new") return void startNew(account, cwd, false);
        if (id === "new-attach") return void startNew(account, cwd, true);
        if (id === "folder") {
          openInDefaultApp(account.dir);
          notify(`opened ${tilde(account.dir)}`);
        }
      },
    });
  };

  const element: ReactNode = (
    <>
      {confirmation && <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />}
      {choice && <ChoiceDialog key={choice.title} layout={layout} choice={choice} onClose={closeChoice} />}
    </>
  );
  return {
    askAccount,
    askHow,
    accountMenu,
    startPairing,
    open: choice !== undefined || confirmation !== undefined || run !== undefined || pairing !== undefined,
    element,
  };
}
