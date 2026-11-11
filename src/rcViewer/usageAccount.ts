import { resolve } from "node:path";
import { avatarOfAccount, barColorOfAccount, type Account, type AccountColorSetting, type AccountInfo } from "../account.js";
import { quotaNote, type Quota } from "../remote/quota.js";
import type { UsageBadge } from "../remote/usage.js";
import type { SessionSummary } from "../transcript/sessions.js";

/**
 * Whose 5-hour and 7-day windows the Remote Control Viewer shows below the chat: the account of the selected session,
 * or one chosen by hand in the list the badge opens (`u`), which stays chosen until "Automatic" is chosen again.
 */

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * The account `session` runs in: another account's session that of its config folder (none where that folder is no
 * account found), a remote one and one of this viewer's folder the viewer's own (`own`): claude.ai lists only its sessions.
 */
export function accountOfSession(session: SessionSummary | undefined, accounts: Account[], own: Account | undefined): Account | undefined {
  if (!session || session.remote || !session.account) return own;
  return accounts.find((a) => samePath(a.dir, session.account!));
}

/** The account shown: the one pinned (its config folder) while it is still found, else the session's (`auto`). */
export function shownAccount(pinned: string | undefined, auto: Account | undefined, accounts: Account[]): { account: Account | undefined; pinned: boolean } {
  const chosen = pinned === undefined ? undefined : accounts.find((a) => samePath(a.dir, pinned));
  return chosen ? { account: chosen, pinned: true } : { account: auto, pinned: false };
}

/** What the badge needs of the accounts' colours and avatars: the viewer's own folder and its live settings. */
export interface BadgeLooks {
  info: Pick<AccountInfo, "own">;
  color: AccountColorSetting;
  avatar: string;
}

/**
 * The badge of `account`: its avatar (`cco` without one) on its colour (none where it is off), the pin, and a note
 * where there are no windows: `API` for an API profile, else why the last read failed.
 */
export function usageBadge(account: Account, looks: BadgeLooks, quota: Pick<Quota, "limits" | "errorKind">, pinned = false): UsageBadge {
  const color = barColorOfAccount(account, looks.info, looks.color);
  const note = account.api ? "API" : !quota.limits && quota.errorKind ? quotaNote(quota.errorKind) : undefined;
  return {
    avatar: avatarOfAccount(account, looks.info, looks.avatar) ?? "cco",
    ...(color !== "gray" && { color }),
    ...(pinned && { pinned }),
    ...(note && { note }),
  };
}
