import { basename, resolve } from "node:path";
import type { Account } from "./account.js";
import { pluginSteps, prepareAccount, runInAccount } from "./accountSetup.js";
import { copyToAccount, type AccountCopy } from "./export/toAccount.js";
import { claudeDir } from "./transcript/locate.js";
import type { SessionSummary } from "./transcript/sessions.js";
import { recordTransfer } from "./transfers.js";
import { runUpdate, type StepResult, type UpdateStep } from "./update.js";

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

/** What to do for continuing a session in another account, or (without `session`) only for starting one there. */
export interface ContinuePlan {
  session?: SessionSummary;
  account: Account;
  /** The email of the account the session is in now (this viewer's), for the note on the copy. */
  fromEmail?: string;
  /** Leave out installing the plugin there (it failed, and the user goes on without hooks). */
  skipPlugin?: boolean;
}

/** How far it is: the steps (installing the plugin, copying) and their state. */
export type ContinueProgress = StepResult[];

export type ContinueResult =
  | { kind: "done"; copy?: AccountCopy }
  /** Installing the plugin failed: nothing else happened; the steps say where. */
  | { kind: "plugin-failed"; steps: StepResult[] }
  | { kind: "failed"; message: string; steps: StepResult[] };

/** The steps of `plan`, as the progress dialog lists them; the plugin's are commands, the rest run in-process. */
export function continueSteps(plan: ContinuePlan): UpdateStep[] {
  return [
    ...(plan.skipPlugin ? [] : pluginSteps(plan.account.dir)),
    ...(plan.session ? [{ label: "copying the session", command: "" }] : []),
  ];
}

/**
 * Continues the session of `plan` in another account, up to the point where it can start there: installs the
 * cco plugin in that account if it lacks it (stopping if that fails, with nothing else done), gives that account
 * cco's CLI path and settings, copies the session into that account's config folder and records the move on both
 * sides. The session where it is now stays as it is. The caller then starts the copy there.
 */
export async function continueInAccount(plan: ContinuePlan, onProgress: (steps: ContinueProgress) => void): Promise<ContinueResult> {
  const steps = continueSteps(plan);
  const commands = steps.filter((s) => s.command);
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
  if (!plan.session) {
    report();
    return { kind: "done" };
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
