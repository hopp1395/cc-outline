import { basename, resolve } from "node:path";
import type { Account } from "./account.js";
import { pluginSteps, prepareAccount, runInAccount } from "./accountSetup.js";
import { copyToAccount, type AccountCopy } from "./export/toAccount.js";
import { typeInClaude, type ConsoleTyper } from "./switchSession.js";
import { TIMING } from "./timing.js";
import { claudeDir } from "./transcript/locate.js";
import type { SessionSummary } from "./transcript/sessions.js";
import { recordTransfer } from "./transfers.js";
import { runUpdate, type StepResult, type UpdateStep } from "./update.js";
import { isAlive } from "./viewer.js";

const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** The accounts a session of this viewer's config folder can continue in: every other one found. */
export function otherAccounts(accounts: Account[], own = claudeDir()): Account[] {
  return accounts.filter((a) => !same(a.dir, own));
}

/**
 * The account `query` names (/cco:account <query>): its email, its folder's path or name (`.claude-work`, or
 * `work` without the `.claude-`), else the only one whose email or folder contains it. Case does not matter.
 */
export function matchAccount(accounts: Account[], query: string): Account | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const folder = (a: Account) => basename(a.dir).toLowerCase();
  const exact = accounts.find((a) => a.email.toLowerCase() === q || folder(a) === q || folder(a) === `.claude-${q}` || same(a.dir, query.trim()));
  if (exact) return exact;
  const partial = accounts.filter((a) => a.email.toLowerCase().includes(q) || folder(a).includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

/** What to do for continuing a session in another account. */
export interface ContinuePlan {
  session: SessionSummary;
  account: Account;
  /** The email of the account the session is in now (this viewer's), for the note on the copy. */
  fromEmail?: string;
  /** The Claude Code the session runs in now, to be closed first (`/exit`); none to leave it running. */
  close?: { pid: number; typer?: ConsoleTyper };
  /** Leave out installing the plugin there (it failed, and the user goes on without hooks). */
  skipPlugin?: boolean;
}

/** How far it is: the steps (installing the plugin, closing, copying) and their state. */
export type ContinueProgress = StepResult[];

export type ContinueResult =
  | { kind: "done"; copy: AccountCopy }
  /** Installing the plugin failed: nothing else happened; the steps say where. */
  | { kind: "plugin-failed"; steps: StepResult[] }
  | { kind: "failed"; message: string; steps: StepResult[] };

/** The steps of `plan`, as the progress dialog lists them; the plugin's are commands, the rest run in-process. */
export function continueSteps(plan: ContinuePlan): UpdateStep[] {
  return [
    ...(plan.skipPlugin ? [] : pluginSteps(plan.account.dir)),
    ...(plan.close ? [{ label: "closing Claude Code", command: "/exit" }] : []),
    { label: "copying the session", command: "" },
  ];
}

/** How long a Claude Code may take to exit after `/exit`. */
export const EXIT_TIMEOUT_MS = 20_000;

/** Types /exit into the Claude Code `pid` and waits until it has gone; the reason if it did not. */
async function closeClaude(close: NonNullable<ContinuePlan["close"]>): Promise<string | undefined> {
  if (!isAlive(close.pid)) return undefined;
  const typed = await typeInClaude(close.pid, "/exit", close.typer);
  if (!typed.typed) return typed.message;
  const until = Date.now() + EXIT_TIMEOUT_MS;
  while (isAlive(close.pid)) {
    if (Date.now() >= until) return `Claude Code did not exit within ${EXIT_TIMEOUT_MS / 1000} s`;
    await new Promise((r) => setTimeout(r, TIMING.pairPoll));
  }
  return undefined;
}

/**
 * Continues the session of `plan` in another account, up to the point where it can start there: installs the
 * cco plugin in that account if it lacks it (stopping if that fails, with nothing else done), gives that account
 * cco's CLI path and settings, closes the Claude Code the session runs in if asked to, copies the session into
 * that account's config folder and records the move on both sides. The caller then starts it there.
 */
export async function continueInAccount(plan: ContinuePlan, onProgress: (steps: ContinueProgress) => void): Promise<ContinueResult> {
  const steps = continueSteps(plan);
  const commands = steps.filter((s) => s.command && s.command !== "/exit");
  const results: StepResult[] = steps.map((step) => ({ step, status: "pending", output: "" }));
  const report = () => onProgress(results.map((r) => ({ ...r })));
  report();
  if (commands.length > 0) {
    const ok = await runUpdate(
      (done) => {
        done.forEach((d, i) => (results[i] = d));
        report();
      },
      runInAccount(plan.account.dir),
      commands,
    );
    if (!ok) return { kind: "plugin-failed", steps: results.map((r) => ({ ...r })) };
  }
  const step = (label: string) => results.find((r) => r.step.label === label)!;
  const fail = (r: StepResult, message: string): ContinueResult => {
    r.status = "failed";
    r.output = message;
    report();
    return { kind: "failed", message, steps: results.map((x) => ({ ...x })) };
  };
  try {
    prepareAccount(plan.account.dir);
  } catch {
    // The plugin then starts cco through the shell, and the viewer there has the default settings.
  }
  if (plan.close) {
    const closing = step("closing Claude Code");
    closing.status = "running";
    report();
    const failed = await closeClaude(plan.close);
    if (failed) return fail(closing, failed);
    closing.status = "done";
  }
  const copying = step("copying the session");
  copying.status = "running";
  report();
  // A moment for the dialog to show the step; the copy itself runs at once.
  await new Promise((r) => setTimeout(r, 50));
  let copy: AccountCopy;
  try {
    copy = copyToAccount(plan.session, plan.account.dir);
  } catch (err) {
    return fail(copying, (err as Error).message);
  }
  if (plan.session.cwd) {
    try {
      recordTransfer(plan.session.cwd, { dir: claudeDir(), email: plan.fromEmail ?? "", id: plan.session.id }, { dir: plan.account.dir, email: plan.account.email, id: copy.id });
    } catch {
      // Only the note of where it went is missing.
    }
  }
  copying.status = "done";
  report();
  return { kind: "done", copy };
}
