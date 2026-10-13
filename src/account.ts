import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { avatarOf } from "./avatar.js";
import { claudeDir, readJson } from "./transcript/locate.js";

/** The Claude account a Claude Code config folder is signed in to, from its `.claude.json`. */
export interface Account {
  /** The config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  dir: string;
  /** The `.claude.json` it was read from. */
  file: string;
  email: string;
  name?: string;
  organization?: string;
  organizationType?: string;
  billing?: string;
  seat?: string;
  rateLimitTier?: string;
  /** The colour chosen in that folder's cco settings (`<dir>/cco/settings.json`); `auto` without one. */
  chosenColor?: AccountColorSetting;
  /** The avatar chosen in that folder's cco settings; none keeps "cco". */
  avatar?: string;
}

/**
 * The console's 16 colours for the account's badge, in ANSI order (0–15) and under Ink's names, so they show in the
 * terminal theme's colours. Each with the text colour that stays readable on it: white on the dark ones, black on
 * the bright ones and white.
 */
export const ACCOUNT_COLORS = {
  black: "whiteBright",
  red: "whiteBright",
  green: "whiteBright",
  yellow: "whiteBright",
  blue: "whiteBright",
  magenta: "whiteBright",
  cyan: "whiteBright",
  white: "black",
  blackBright: "black",
  redBright: "black",
  greenBright: "black",
  yellowBright: "black",
  blueBright: "black",
  magentaBright: "black",
  cyanBright: "black",
  whiteBright: "black",
} as const;
export type AccountColorName = keyof typeof ACCOUNT_COLORS;
export const ACCOUNT_COLOR_NAMES = Object.keys(ACCOUNT_COLORS) as AccountColorName[];
/** The colours `auto` picks from: the coloured ones, without black, white and gray, and without blue, the focus bar's. */
export const AUTO_COLORS: AccountColorName[] = ["red", "green", "yellow", "magenta", "cyan", "redBright", "greenBright", "yellowBright", "magentaBright", "cyanBright"];
/** The setting's values: `auto` takes the colour from the email, `off` shows none in the top bar, the rest fix it. */
export const ACCOUNT_COLOR_VALUES = ["auto", "off", ...ACCOUNT_COLOR_NAMES] as const;
export type AccountColorSetting = (typeof ACCOUNT_COLOR_VALUES)[number];

/** FNV-1a, so the same email always gets the same colour on every machine. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The colour name of an account: the email's hash, or `chosen` where it is not `auto`. */
export function accountColorName(email: string, chosen: AccountColorSetting = "auto"): AccountColorName {
  if (chosen !== "auto" && chosen !== "off") return chosen;
  return AUTO_COLORS[hash(email.trim().toLowerCase()) % AUTO_COLORS.length];
}

const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The account `dir` is signed in to; none without a `.claude.json` or an email in it. */
export function readAccount(dir: string, home = homedir()): Account | undefined {
  // Claude Code keeps it in the config folder; only the default folder's lives next to it, in ~/.claude.json.
  const files = [join(dir, ".claude.json"), ...(same(dir, join(home, ".claude")) ? [join(home, ".claude.json")] : [])];
  for (const file of files) {
    const stored = readJson<{ oauthAccount?: Record<string, unknown> }>(file)?.oauthAccount;
    const email = text(stored?.emailAddress);
    if (!stored || !email) continue;
    return {
      dir,
      file,
      email,
      name: text(stored.displayName) ?? text(stored.fullName),
      organization: text(stored.organizationName),
      organizationType: text(stored.organizationType),
      billing: text(stored.billingType),
      seat: text(stored.seatTier),
      rateLimitTier: text(stored.organizationRateLimitTier),
      chosenColor: chosenColorOf(dir),
      avatar: chosenAvatarOf(dir),
    };
  }
  return undefined;
}

/**
 * The colour chosen for the account of `dir` in its own cco settings, read here since settings.ts depends on
 * this module; `auto` without one. The former on/off setting `accountBadge` counts as `off`.
 */
export function chosenColorOf(dir: string): AccountColorSetting {
  const stored = readJson<{ accountColor?: unknown; accountBadge?: unknown }>(join(dir, "cco", "settings.json"));
  const value = stored?.accountColor;
  if ((ACCOUNT_COLOR_VALUES as readonly unknown[]).includes(value)) return value as AccountColorSetting;
  return value === undefined && stored?.accountBadge === false ? "off" : "auto";
}

/** The avatar chosen for the account of `dir` in its own cco settings; none where it keeps "cco" or the value is not one. */
export function chosenAvatarOf(dir: string): string | undefined {
  return avatarOf(readJson<{ accountAvatar?: unknown }>(join(dir, "cco", "settings.json"))?.accountAvatar);
}

/** The folders that may hold an account: this viewer's own, the default one and every `~/.claude*` folder. */
export function accountDirs(home = homedir(), own = claudeDir()): string[] {
  const dirs = [own, join(home, ".claude")];
  try {
    for (const name of readdirSync(home)) {
      if (!name.startsWith(".claude")) continue;
      const path = join(home, name);
      try {
        if (statSync(path).isDirectory()) dirs.push(path);
      } catch {
        // gone in the meantime
      }
    }
  } catch {
    // no readable home folder
  }
  return dirs.filter((dir, i) => dirs.findIndex((d) => same(d, dir)) === i);
}

/** Every account found, the viewer's own first. */
export function findAccounts(home = homedir(), own = claudeDir()): Account[] {
  return accountDirs(home, own).flatMap((dir) => readAccount(dir, home) ?? []);
}

/**
 * The account of the Claude Code process `pid`: that of the folder whose `sessions/<pid>.json` it wrote, else
 * `fallback` (the viewer's own).
 */
export function accountOfProcess(pid: number | undefined, accounts: Account[], fallback: Account | undefined): Account | undefined {
  if (pid === undefined) return fallback;
  return accounts.find((a) => existsSync(join(a.dir, "sessions", `${pid}.json`))) ?? fallback;
}

/** The accounts found, the one shown and whether the display is worth showing: only with two or more. */
export interface AccountInfo {
  accounts: Account[];
  current?: Account;
  multiple: boolean;
  /** The viewer's own folder, whose settings hold the colour chosen there. */
  own: string;
}

export function accountInfo(pid?: number, home = homedir(), own = claudeDir()): AccountInfo {
  const accounts = findAccounts(home, own);
  const ownAccount = accounts.find((a) => same(a.dir, own));
  return { accounts, current: accountOfProcess(pid, accounts, ownAccount), multiple: accounts.length >= 2, own };
}

/**
 * The colour (name) of `account`: for this viewer's own folder the one chosen in its settings (`chosen`, which
 * may have changed since the folders were read), for another the one chosen in that folder's settings, else
 * from the email.
 */
export function colorOfAccount(account: Account, info: Pick<AccountInfo, "own">, chosen: AccountColorSetting): AccountColorName {
  return accountColorName(account.email, same(account.dir, info.own) ? chosen : (account.chosenColor ?? "auto"));
}

/**
 * When the account of `account.dir` was last used: Claude Code adds each prompt to `history.jsonl` there; without it,
 * when its `.claude.json` was written. 0 if neither can be read.
 */
export function accountUsedAt(account: Pick<Account, "dir" | "file">): number {
  for (const file of [join(account.dir, "history.jsonl"), account.file]) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      // not there
    }
  }
  return 0;
}

/** The colour of the bar that marks the sessions of `account` in the Sessions view: its colour, gray where it is `off`. */
export function barColorOfAccount(account: Account, info: Pick<AccountInfo, "own">, chosen: AccountColorSetting): AccountColorName | "gray" {
  const value = same(account.dir, info.own) ? chosen : (account.chosenColor ?? "auto");
  return value === "off" ? "gray" : accountColorName(account.email, value);
}

/**
 * The avatar of `account`: for this viewer's own folder the one in its settings (`chosen`, the live setting), for
 * another the one in that folder's settings; undefined keeps "cco".
 */
export function avatarOfAccount(account: Account, info: Pick<AccountInfo, "own">, chosen: string): string | undefined {
  return same(account.dir, info.own) ? avatarOf(chosen) : account.avatar;
}

/** Whether the colour of `account` is a fixed one rather than taken from the email. */
export function hasChosenColor(account: Account, info: Pick<AccountInfo, "own">, chosen: AccountColorSetting): boolean {
  const value = same(account.dir, info.own) ? chosen : account.chosenColor;
  return value !== undefined && value !== "auto" && value !== "off";
}
