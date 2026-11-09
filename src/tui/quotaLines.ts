import { levelOf, percentOf, untilReset, type LimitWindow, type UsageLevel } from "../remote/usage.js";
import { bold, dim } from "./layout.js";
import type { QuotaState } from "./useQuota.js";

const LEVEL_ANSI: Record<UsageLevel, (s: string) => string> = {
  low: (s) => s,
  mid: (s) => `\u001b[33m${s}\u001b[39m`,
  high: (s) => `\u001b[31m${s}\u001b[39m`,
};

/** The columns of a window's bar. */
const BAR = 10;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** When a window starts anew, as a clock reads it: `16:40` today, else `Thu 09:00`, a week or more away `12/24 09:00`. */
export function resetTime(resetsAt: number, now: number): string {
  const at = new Date(resetsAt * 1000);
  const today = new Date(now);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  if (at.toDateString() === today.toDateString()) return time;
  if (resetsAt * 1000 - now < 6 * 86_400_000) return `${WEEKDAYS[at.getDay()]} ${time}`;
  return `${pad2(at.getMonth() + 1)}/${pad2(at.getDate())} ${time}`;
}

/** How long ago `at` (ms) was: `just now`, `3 min ago`, `2 h ago`. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** One window's row: `5 hours  ████░░░░░░  42 %  resets 16:40 (in 2h14m)`. */
function windowLine(label: string, window: LimitWindow | undefined, stale: boolean, now: number): string {
  const name = label.padEnd(9);
  if (!window) return `${name}${dim("not reported")}`;
  const percent = percentOf(window);
  const color = stale ? dim : LEVEL_ANSI[levelOf(percent)];
  const filled = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)));
  const bar = color("█".repeat(filled)) + dim("░".repeat(BAR - filled));
  const left = window.resetsAt === undefined ? undefined : untilReset(window.resetsAt, now);
  const reset =
    window.resetsAt === undefined ? "not started" : left ? `resets ${resetTime(window.resetsAt, now)} (in ${left})` : "started anew, not read since";
  return `${name}${bar}  ${color(`${String(percent).padStart(3)} %`)}  ${dim(reset)}`;
}

/**
 * The preview of the account's 5-hour and 7-day windows in Settings: a bar, the percentage and when each starts
 * anew, when they were read and why the last read failed; or why none are read.
 */
export function quotaLines(quota: QuotaState | undefined, wrap: (text: string) => string[], now = Date.now()): string[] {
  const about = wrap(
    dim(
      "Read from claude.ai once a minute (for all viewers of this account at once), as Claude Code's `/usage` shows it. The Remote Control Viewer shows them at the right of the prompt line's border; yellow from 75 %, red from 90 %.",
    ),
  );
  if (!quota || quota.reason === "none") return wrap("No account: the windows belong to a claude.ai login. Sign in with `/login` in Claude Code.");
  if (quota.reason === "api") return wrap("This config folder is an API profile: its Claude Code talks to another server, which has no 5-hour or 7-day windows.");
  if (quota.reason === "off") {
    return [
      ...wrap("Not read: the windows come from claude.ai through the same undocumented interface as the remote sessions, so they need the setting remote API (Sessions) on."),
      "",
      ...about,
    ];
  }
  const { limits, stale, seenAt, error } = quota;
  const status = [seenAt !== undefined ? `as of ${ago(seenAt, now)}` : undefined, stale ? "not current" : undefined, error].filter(Boolean).join(" · ");
  if (!limits) return [...wrap(error ? `Not read: ${error}` : "Not read yet."), "", ...about];
  return [
    bold("Usage"),
    windowLine("5 hours", limits.fiveHour, stale, now),
    windowLine("7 days", limits.sevenDay, stale, now),
    ...(status ? ["", ...wrap(stale ? status : dim(status))] : []),
    "",
    ...about,
  ];
}
