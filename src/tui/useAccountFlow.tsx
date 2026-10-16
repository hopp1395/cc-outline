import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { useEffect, useState, type ReactNode } from "react";
import type { Account } from "../account.js";
import { continueInAccount, matchAccount, otherAccounts, type ContinuePlan } from "../accountContinue.js";
import { pluginSteps } from "../accountSetup.js";
import { accountsHome, checkNewAccount, claudeBinDir, powershellAliases, writeAccountFiles, type StartScript } from "../addAccount.js";
import { AddAccountDialog } from "./AddAccountDialog.js";
import {
  accountDeleteBlocker,
  accountTrashPlan,
  emptyAccountTrash,
  purgeAccount,
  restoreAccount,
  sizeText,
  trashAccount,
  type AccountTrashEntry,
} from "../accountTrash.js";
import { TypedConfirmDialog, type TypedConfirmation } from "./TypedConfirmDialog.js";
import { detectTerminal, openInDefaultApp, resumeForPairing, resumeInNewWindow, resumeShellCommand, scriptInNewWindow } from "../open.js";
import { TIMING } from "../timing.js";
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
  /** Where it runs: a Windows Terminal window name or a tmux pane id; not yet known while it is being started. */
  where?: string;
  /** Epoch ms. */
  started: number;
  /** It did not start or show up in time: what the dialog says until Esc. */
  failed?: { text: string; lines: string[] };
}

/** The pairing's progress dialog: starting Claude Code, waiting for it (Esc cancels), or why it failed. */
export function pairingProgress(pairing: Pairing, now: number, onCancel: () => void, onClose: () => void): Progress {
  const title = "Attach this viewer";
  if (pairing.failed) return { title, status: "failed", ...pairing.failed, onClose };
  if (pairing.where === undefined) return { title, status: "running", text: "Starting Claude Code", onCancel };
  const total = PAIR_TIMEOUT_MS / 1000;
  const waited = Math.min(total, Math.floor((now - pairing.started) / 1000));
  return { title, status: "running", text: "Waiting for Claude Code", detail: `${waited} of ${total} s · the viewer moves next to it once it runs`, onCancel };
}

const progressSteps = (steps: StepResult[]) => steps.map((r) => ({ label: r.step.label, status: r.status, output: r.output }));

/** Continuing a session in another account (or preparing it for a new one), until its Claude Code starts there. */
export function continueProgress(account: Account, steps: StepResult[], session: string, title = `Continue in ${account.email}`): Progress {
  const step = currentStep(progressSteps(steps));
  const verb = step?.label === "copying the session" ? "Copying" : "Installing the cco plugin";
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
  /** The Claude Code process the viewer belongs to. */
  claudePid?: number;
  /** A Claude Code the viewer started runs now `where`: the viewer moves next to it, paired. */
  onPairStarted?: (target: PairTarget, where: string) => void;
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
export function useAccountFlow({ layout, claudePid, onPairStarted, notify, onCopied }: Options) {
  const accountState = useAccountState();
  const others = otherAccounts(accountState.accounts);
  const copy = useClipboard();
  const [choice, setChoice] = useState<Choice>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // The second confirmation of the danger zone: a word to type.
  const [typed, setTyped] = useState<TypedConfirmation>();
  // The account moved to the trash last, for u (undo); and a count that tells the trash list to read again.
  const [lastTrashed, setLastTrashed] = useState<string>();
  const [trashChanged, setTrashChanged] = useState(0);
  const [viewAccounts] = useSetting("viewAccounts");
  const [run, setRun] = useState<Progress>();
  const [pairing, setPairing] = useState<Pairing>();
  // Adding an account: where its start scripts go, while the dialog asks for its names.
  const [adding, setAdding] = useState<{ cwd: string; dir: string; onPath: boolean }>();
  const [, setPairTick] = useState(0);
  const fromEmail = accountState.current?.email;
  const [accountColor] = useSetting("accountColor");
  const ctx: HeadContext = { accounts: accountState, accountColor };
  /** The head of the dialogs about `s`: where it runs is the viewer's own Claude Code, another, or none. */
  const headOf = (s: SessionSummary, claude: RunningSession | undefined, dir: string) =>
    sessionHead(s, ctx, { dir, gone: !existsSync(dir), state: claude ? (claude.pid === claudePid ? "current" : "active") : "inactive" });

  /**
   * Starts a session in a new window, where Claude Code's hook leaves opening a viewer to this one, then waits for it.
   */
  const startPairing = async (s: Pick<SessionSummary, "id" | "path">, title: string, dir: string) => {
    requestPairing(dir, s.id, Date.now() + 2 * PAIR_TIMEOUT_MS);
    // Waiting from now on, so a second Enter starts nothing more.
    const started: Pairing = { sessionId: s.id, cwd: dir, transcript: s.path, started: Date.now() };
    setPairing(started);
    const { message, target } = await resumeForPairing(s.id, dir, truncate(title, 30));
    if (!target) {
      cancelPairing(dir, s.id);
      return setPairing((p) => (p === started ? { ...started, failed: { text: "Claude Code did not start", lines: [message] } } : p));
    }
    setPairing((p) => (p === started ? { ...started, where: target } : p));
  };
  /** Withdraws the pairing's request. */
  const withdraw = (p: Pairing) => cancelPairing(p.cwd, p.sessionId);
  /** Esc while it waits: the request is withdrawn; the Claude Code started keeps running. */
  const cancelWait = () => {
    if (pairing) withdraw(pairing);
    setPairing(undefined);
    notify("pairing cancelled; Claude Code keeps running in its window");
  };
  // Waiting: pairs once the session's Claude Code registers itself, gives up after PAIR_TIMEOUT_MS.
  useEffect(() => {
    if (!pairing || pairing.failed) return;
    const timer = setInterval(() => {
      const claude = pairing.where !== undefined ? runningSessions().get(pairing.sessionId) : undefined;
      if (claude && pairing.where !== undefined) {
        clearInterval(timer);
        setPairing(undefined);
        // The request stays for its hook, which may be still to come; it expires by itself.
        const target: PairTarget = { cwd: pairing.cwd, claudePid: claude.pid, sessionId: pairing.sessionId, transcript: pairing.transcript };
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
  useProgress(
    pairing
      ? pairingProgress(pairing, Date.now(), cancelWait, () => setPairing(undefined))
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

  /** What continuing `s` in `account` does, asked before it starts. The session and its viewer stay as they are. */
  const askHow = (s: SessionSummary, account: Account, claude: RunningSession | undefined, dir: string) => {
    const plugin = pluginSteps(account.dir);
    const lines = [
      ...headOf(s, claude, dir),
      "",
      truncate(`A copy continues in ${account.email}, in a new window`, HEAD_WIDTH),
      ...(plugin.length ? ["with the cco plugin installed there first"] : []),
      "This session and its viewer stay as they are.",
    ];
    setConfirmation({ title: `Continue in ${truncate(account.email, 44)}?`, lines, onConfirm: () => void runContinue({ session: s, account, fromEmail }, dir) });
  };

  /** The plugin could not be installed: says why, and on Esc asks whether to go on without it. */
  const pluginFailed = (steps: StepResult[], title: string, head: string[], goOn: () => void) => {
    // Only the plugin's commands; copying runs here.
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

  /**
   * Starts the session `id` in `account`, in the folder `dir`, in a new window, where its hook opens a viewer of its
   * own; without a terminal to open one in, the dialog shows the command. `fresh`: a new session under that id.
   */
  const startThere = (id: string, account: Account, dir: string, title: string, name: string, fresh: boolean) => {
    if (!detectTerminal()) {
      const command = resumeShellCommand(id, account.dir, process.platform, fresh);
      return setRun({
        title,
        status: "done",
        text: "Start it by hand",
        lines: ["No Windows Terminal or tmux to open a window in. Run in a terminal:", `  ${command}`, `in ${tilde(dir)}`],
        copy: () => void copy(command).then(() => notify(`copied: ${command}`)),
      });
    }
    notify(resumeInNewWindow(id, dir, truncate(name, 30), "new", account.dir, fresh));
  };

  /** Runs the steps up to the copy in the progress dialog, then starts the copy in the other account. */
  const runContinue = async (plan: ContinuePlan, dir: string) => {
    const { account } = plan;
    const s = plan.session!;
    const title = `Continue in ${account.email}`;
    const name = truncate(sessionTitle(s), 40);
    const result = await continueInAccount(plan, (steps) => setRun(continueProgress(account, steps, name)));
    if (result.kind === "plugin-failed") {
      return pluginFailed(result.steps, title, [...headOf(s, undefined, dir).slice(0, -1), truncate(`to continue in ${account.email}`, HEAD_WIDTH)], () =>
        void runContinue({ ...plan, skipPlugin: true }, dir),
      );
    }
    if (result.kind === "failed") return setRun({ title, status: "failed", text: "The session was not continued there", lines: [result.message] });
    setRun(undefined);
    onCopied?.();
    if (result.copy) startThere(result.copy.id, account, dir, title, sessionTitle(s), false);
  };

  /** Starts a new session in `account`, in the folder `dir`, in a new window. The cco plugin is installed there first if it lacks it. */
  const startNew = async (account: Account, dir: string, skipPlugin = false) => {
    const title = `New session in ${account.email}`;
    const result = await continueInAccount({ account, fromEmail, skipPlugin }, (steps) => setRun(continueProgress(account, steps, tilde(dir), title)));
    if (result.kind === "plugin-failed")
      return pluginFailed(result.steps, title, [truncate(`a new session in ${account.email}`, HEAD_WIDTH), truncate(`in ${tilde(dir)}`, HEAD_WIDTH)], () => void startNew(account, dir, true));
    if (result.kind === "failed") return setRun({ title, status: "failed", text: "No session was started", lines: [result.message] });
    setRun(undefined);
    startThere(randomUUID(), account, dir, title, "new session", true);
  };

  /**
   * What can be done with `account` (Accounts view, Settings): continue the viewer's session there (`own`; else
   * greyed out with `noSession`), start a new session there, open its config folder.
   */
  const accountMenu = (account: Account, cwd: string, own: OwnSession | undefined, noSession?: string) => {
    const active = account.dir === accountState.current?.dir;
    const blocker = accountDeleteBlocker(account.dir, accountState.current?.dir);
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
        { id: "folder", label: "Open its config folder", detail: truncate(tilde(account.dir), HEAD_WIDTH) },
        { id: "trash", label: "Move this account to the trash…", detail: "its folder and start scripts; they can be restored", disabled: blocker, danger: true },
      ],
      initial: !active && own ? 0 : 1,
      onChoose: (id) => {
        setChoice(undefined);
        if (id === "continue" && own) return askHow(own.summary, account, own.claude, own.dir);
        if (id === "new") return void startNew(account, cwd);
        if (id === "trash") return askTrash(account);
        if (id === "folder") {
          openInDefaultApp(account.dir);
          notify(`opened ${tilde(account.dir)}`);
        }
      },
    });
  };

  /** Where the accounts trash is: in the Accounts view, reached with 0, or with /cco:accounts while that view is off. */
  const trashHint = viewAccounts ? "0 › T" : "/cco:accounts › T";
  const accountLine = (account: Account) => `${accountBar(account, accountState, accountColor)} ${truncate(`${account.email} · ${tilde(account.dir)}`, HEAD_WIDTH - 2)}`;
  const changed = () => {
    accountState.refresh?.();
    setTrashChanged((n) => n + 1);
  };
  const failed = (title: string, text: string, err: unknown) => setRun({ title, status: "failed", text, lines: [(err as Error).message] });
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /**
   * Moves `account` to the trash after two confirmations: what moves, then its folder name typed. Refused with the
   * reason for the default and the active account and while a Claude Code or a viewer runs with it.
   */
  const askTrash = (account: Account) => {
    const blocker = accountDeleteBlocker(account.dir, accountState.current?.dir);
    if (blocker) return notify(`can't delete: ${blocker}`);
    const plan = accountTrashPlan(account);
    setConfirmation({
      title: "Move this account to the trash?",
      danger: true,
      lines: [
        accountLine(account),
        ...(account.organization ? [truncate(`organization ${account.organization}`, HEAD_WIDTH)] : []),
        `${count(plan.sessions, "session")} · ${sizeText(plan.size)}`,
        ...(plan.scripts.length ? plan.scripts.map((f) => truncate(`script  ${tilde(f)}`, HEAD_WIDTH)) : ["no start script found"]),
        "",
        `It can be restored from the trash (${trashHint}).`,
      ],
      onConfirm: () =>
        setTyped({
          title: "Really move it to the trash?",
          lines: [accountLine(account)],
          word: basename(account.dir),
          onConfirm: () => {
            try {
              const entry = trashAccount(account, accountState.current?.dir);
              setLastTrashed(entry.id);
              changed();
              notify(`moved to the trash · u undo · ${trashHint} trash`);
            } catch (err) {
              failed("Move to the trash", "The account was not moved", err);
            }
          },
        }),
    });
  };

  /** Brings an account back from the trash; refused when its folder or a script exists again. */
  const restore = (id: string) => {
    try {
      const entry = restoreAccount(id);
      if (id === lastTrashed) setLastTrashed(undefined);
      changed();
      notify(`restored ${entry.account.email}`);
    } catch (err) {
      failed("Restore the account", "The account was not restored", err);
    }
  };
  /** u after a move to the trash: brings it back. False when there is nothing to undo. */
  const undoTrash = () => {
    if (!lastTrashed) return false;
    restore(lastTrashed);
    return true;
  };

  /** Deletes an account in the trash for good, after two confirmations. */
  const askPurge = (entry: AccountTrashEntry, cwd: string) => {
    const head = truncate(`${entry.account.email} · ${tilde(entry.folder.from)}`, HEAD_WIDTH);
    setConfirmation({
      title: "Delete this account for good?",
      danger: true,
      lines: [
        head,
        `${count(entry.sessions, "session")} · ${sizeText(entry.size)}${entry.scripts.length ? ` · ${count(entry.scripts.length, "script")}` : ""}`,
        "",
        "Its login, sessions and settings are deleted.",
        "This can't be undone.",
      ],
      onConfirm: () =>
        setTyped({
          title: "Really delete it for good?",
          lines: [head],
          word: basename(entry.folder.from),
          onConfirm: () => {
            try {
              purgeAccount(entry.id, cwd);
              changed();
              notify(`deleted ${entry.account.email} for good`);
            } catch (err) {
              failed("Delete the account", "The account was not deleted", err);
            }
          },
        }),
    });
  };

  /** Empties the accounts trash, after two confirmations (the second: `delete` typed). */
  const askEmpty = (entries: AccountTrashEntry[], cwd: string) => {
    if (entries.length === 0) return;
    const accounts = count(entries.length, "account");
    setConfirmation({
      title: "Empty the accounts trash?",
      danger: true,
      lines: [accounts, "", "They are deleted for good, with their logins,", "sessions and settings. This can't be undone."],
      onConfirm: () =>
        setTyped({
          title: "Really empty the trash?",
          lines: [accounts],
          word: "delete",
          onConfirm: () => {
            try {
              emptyAccountTrash(cwd);
              changed();
              notify("accounts trash emptied");
            } catch (err) {
              failed("Empty the trash", "The trash was not emptied", err);
            }
          },
        }),
    });
  };

  /** Asks for the command and folder of a new account (Settings and Accounts view, "how to add an account"). */
  const askAddAccount = (cwd: string) => setAdding({ cwd, ...claudeBinDir() });

  /** Checks a new account's names; on Windows PowerShell is asked for its aliases first. */
  const checkAccount = async (command: string, folder: string) =>
    checkNewAccount(command, folder, { binDir: adding?.dir ?? claudeBinDir().dir, aliases: process.platform === "win32" ? await powershellAliases() : undefined });

  /** Creates the folder and the start scripts, then prepares cco there and opens a window to sign in. */
  const addAccount = (command: string, folderName: string) => {
    if (!adding) return;
    const { cwd, dir: binDir } = adding;
    setAdding(undefined);
    const dir = join(accountsHome.get(), folderName);
    try {
      void prepareAdded(command, dir, cwd, writeAccountFiles(command, dir, binDir));
    } catch (err) {
      setRun({ title: `Add ${command}`, status: "failed", text: "The account was not added", lines: [(err as Error).message] });
    }
  };

  const prepareAdded = async (command: string, dir: string, cwd: string, scripts: StartScript[], skipPlugin = false) => {
    const title = `Add ${command}`;
    const account: Account = { dir, file: join(dir, ".claude.json"), email: basename(dir) };
    const result = await continueInAccount({ account, fromEmail, skipPlugin }, (steps) => setRun(continueProgress(account, steps, tilde(dir), title)));
    if (result.kind === "plugin-failed")
      return pluginFailed(result.steps, title, [truncate(`the new account ${command}`, HEAD_WIDTH), truncate(tilde(dir), HEAD_WIDTH)], () => void prepareAdded(command, dir, cwd, scripts, true));
    if (result.kind === "failed") return setRun({ title, status: "failed", text: "cco could not be prepared there", lines: [result.message] });
    const written = [truncate(`folder  ${tilde(dir)}`, HEAD_WIDTH), ...scripts.map((s) => truncate(`script  ${tilde(s.file)}`, HEAD_WIDTH))];
    const started = scriptInNewWindow(scripts[0]!.file, cwd, command);
    if (started) {
      notify(started);
      return setRun({ title, status: "done", text: "Sign in there with /login", lines: [...written, "", "A new window runs it; once signed in, the account shows here."] });
    }
    setRun({
      title,
      status: "done",
      text: "Start it by hand",
      lines: [...written, "", `No Windows Terminal or tmux: run ${command} in a terminal`, "and sign in with /login."],
      copy: () => void copy(command).then(() => notify(`copied: ${command}`)),
    });
  };

  const element: ReactNode = (
    <>
      {adding && (
        <AddAccountDialog layout={layout} binDir={tilde(adding.dir)} onPath={adding.onPath} check={checkAccount} onAdd={addAccount} onCancel={() => setAdding(undefined)} />
      )}
      {confirmation && <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />}
      {typed && <TypedConfirmDialog key={typed.title} layout={layout} confirmation={typed} onClose={() => setTyped(undefined)} />}
      {choice && <ChoiceDialog key={choice.title} layout={layout} choice={choice} onClose={() => setChoice(undefined)} />}
    </>
  );
  return {
    askAccount,
    askHow,
    accountMenu,
    askAddAccount,
    askTrash,
    askPurge,
    askEmpty,
    restore,
    undoTrash,
    trashChanged,
    startPairing,
    open: choice !== undefined || confirmation !== undefined || run !== undefined || pairing !== undefined || adding !== undefined || typed !== undefined,
    element,
  };
}
