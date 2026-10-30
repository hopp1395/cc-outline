import { homedir } from "node:os";
import { barColorOfAccount, type Account, type AccountColorName, type AccountColorSetting } from "../account.js";
import { otherAccounts } from "../accountContinue.js";
import { isCommand } from "../transcript/parse.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { truncate } from "./layout.js";
import type { AccountState } from "./useAccount.js";

/**
 * The name shown for a session, as Claude Code names it: its /rename title, the title Claude Code gave it, the name
 * its running Claude Code shows; else its first prompt that is not a slash or `!` command.
 */
export function sessionTitle(s: SessionSummary): string {
  return s.title ?? s.aiTitle ?? s.name ?? (s.prompts.find((p) => !isCommand(p.text)) ?? s.prompts[0])?.text ?? s.id;
}

/** How wide the lines of a dialog may be: its width less the frame and padding. */
export const HEAD_WIDTH = 56;

const pad = (n: number) => String(n).padStart(2, "0");
function time(ts: string): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "2026-09-26 20:48–22:53", with the end date only when it differs. */
export function span(start?: string, end?: string): string {
  if (!start) return "";
  const s = new Date(start);
  const date = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!end) return `${date(s)} ${time(start)}`;
  const e = new Date(end);
  if (date(e) === date(s) && time(end) === time(start)) return `${date(s)} ${time(start)}`;
  return `${date(s)} ${time(start)}–${date(e) === date(s) ? "" : date(e) + " "}${time(end)}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Replaces the home directory with ~. */
export function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

/** SGR foreground code of a console colour, by Ink's name. */
export function fg(name: AccountColorName | "gray"): number {
  const names: AccountColorName[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  if (name === "gray") return 90;
  const bright = name.endsWith("Bright");
  return (bright ? 90 : 30) + names.indexOf(bright ? (name.slice(0, -6) as AccountColorName) : name);
}

/** The account's bar `▌` in its colour (gray where its colour is off). */
export function accountBar(account: Account, accounts: Pick<AccountState, "own">, chosen: AccountColorSetting): string {
  return `\u001b[${fg(barColorOfAccount(account, accounts, chosen))}m▌\u001b[39m`;
}

/** What the head says of where a session stands; `trash` names when it went there. */
export type HeadState = "current" | "active" | "inactive" | { trash: string };

const STATE_TEXT: Record<"current" | "active" | "inactive", string> = {
  current: "this viewer's session",
  active: "runs in a Claude Code",
  inactive: "runs nowhere",
};

/** What every dialog about a session needs to describe it: the accounts found and the colour chosen here. */
export interface HeadContext {
  accounts: Pick<AccountState, "accounts" | "own">;
  accountColor: AccountColorSetting;
}

/** The account a session belongs to: another account's (`s.account`), else the viewer's own. */
export function accountOfSession(s: Pick<SessionSummary, "account">, accounts: Pick<AccountState, "accounts" | "own">): Account | undefined {
  const own = accounts.accounts.find((a) => otherAccounts([a], accounts.own).length === 0);
  return s.account ? otherAccounts(accounts.accounts, accounts.own).find((a) => a.dir === s.account) : own;
}

/** The line naming an account: its bar, its email and, for the viewer's own, that it is this one. */
export function accountLine(account: Account, ctx: HeadContext, own: boolean): string {
  return `${accountBar(account, ctx.accounts, ctx.accountColor)} ${truncate(`${account.email}${own ? " · this account" : ""}`, HEAD_WIDTH - 2)}`;
}

/**
 * The lines every dialog about one session starts with: its title; its time span, prompts and files; its
 * account (with two or more found); its folder, or that it is gone; where it stands.
 */
export function sessionHead(s: SessionSummary, ctx: HeadContext, where: { dir: string; gone: boolean; state: HeadState }): string[] {
  const account = ctx.accounts.accounts.length >= 2 ? accountOfSession(s, ctx.accounts) : undefined;
  return [
    truncate(sessionTitle(s), HEAD_WIDTH),
    [span(s.start, s.end), plural(s.prompts.length, "prompt"), plural(s.files.length, "file")].filter(Boolean).join(" · "),
    ...(account ? [accountLine(account, ctx, !s.account)] : []),
    truncate(`${where.gone ? "folder gone:" : "in"} ${tilde(where.dir)}`, HEAD_WIDTH),
    typeof where.state === "string" ? STATE_TEXT[where.state] : `in the trash since ${where.state.trash}`,
  ];
}

/** The line of a dialog about several sessions, in place of the head. */
export const countHead = (n: number, what: string, where?: string) => `${plural(n, what)}${where ? ` · ${where}` : ""}`;
