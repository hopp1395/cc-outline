import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
}

/** Dark colours for the account's badge, each readable with white text and apart from the blue focus bar. */
export const ACCOUNT_COLORS = {
  teal: "#0f766e",
  green: "#3f7d20",
  amber: "#a15c07",
  orange: "#c2410c",
  red: "#b91c1c",
  pink: "#be185d",
  purple: "#7e22ce",
  indigo: "#4338ca",
} as const;
export type AccountColorName = keyof typeof ACCOUNT_COLORS;
export const ACCOUNT_COLOR_NAMES = Object.keys(ACCOUNT_COLORS) as AccountColorName[];
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
  return ACCOUNT_COLOR_NAMES[hash(email.trim().toLowerCase()) % ACCOUNT_COLOR_NAMES.length];
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
    };
  }
  return undefined;
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
 * The colour (name) of `account`: the one chosen in this viewer's settings for its own folder, else from the
 * email. The other folders' settings are not read.
 */
export function colorOfAccount(account: Account, info: Pick<AccountInfo, "own">, chosen: AccountColorSetting): AccountColorName {
  return accountColorName(account.email, same(account.dir, info.own) ? chosen : "auto");
}
