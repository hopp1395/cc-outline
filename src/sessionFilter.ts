import { basename, dirname, resolve } from "node:path";
import { ACCOUNT_DIRS_SEPARATOR, DEFAULT_SETTINGS, type SessionsBackground, type SessionsFolders, type Settings } from "./settings.js";
import { projectSlug } from "./transcript/locate.js";
import type { SessionBackground, SessionSummary } from "./transcript/sessions.js";

/** What the Sessions view lists (a opens its dialog): the project folders, the accounts' config folders and the background sessions. */
export interface SessionFilter {
  folders: SessionsFolders;
  /** The chosen config folders of the accounts found, this viewer's own first if chosen; never empty. */
  accounts: string[];
  background: SessionsBackground;
}

const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * The filter the settings describe, among the accounts found (`own`, this viewer's config folder, and `others`):
 * `current` is the own one, `all` every one found (also accounts added later), a list the folders named that are
 * still found, else the own one.
 */
export function sessionFilter(settings: Pick<Settings, "sessionsFolders" | "sessionsAccounts" | "sessionsBackground">, own: string, others: string[]): SessionFilter {
  const found = [own, ...others];
  const value = settings.sessionsAccounts;
  let accounts: string[];
  if (value === "current") accounts = [own];
  else if (value === "all") accounts = found;
  else {
    const named = value.split(ACCOUNT_DIRS_SEPARATOR);
    accounts = found.filter((dir) => named.some((n) => same(n, dir)));
    if (accounts.length === 0) accounts = [own];
  }
  return { folders: settings.sessionsFolders, accounts, background: settings.sessionsBackground };
}

/** The settings that store `filter`: `current` for the own account alone, `all` for every one found, else the folders. */
export function filterSettings(filter: SessionFilter, own: string, others: string[]): Pick<Settings, "sessionsFolders" | "sessionsAccounts" | "sessionsBackground"> {
  const found = [own, ...others];
  const chosen = found.filter((dir) => filter.accounts.some((a) => same(a, dir)));
  const accounts =
    chosen.length === 0 || (chosen.length === 1 && same(chosen[0]!, own))
      ? "current"
      : chosen.length === found.length
        ? "all"
        : chosen.join(ACCOUNT_DIRS_SEPARATOR);
  return { sessionsFolders: filter.folders, sessionsAccounts: accounts, sessionsBackground: filter.background };
}

/** Whether `filter` lists other folders, other accounts or limits the background sessions: a in the help line is shown on. */
export function filterIsSet(filter: SessionFilter, own: string): boolean {
  return (
    filter.folders !== DEFAULT_SETTINGS.sessionsFolders ||
    filter.background !== DEFAULT_SETTINGS.sessionsBackground ||
    filter.accounts.length !== 1 ||
    !same(filter.accounts[0]!, own)
  );
}

/** Whether `filter` chose the account of config folder `dir`. */
export const accountChosen = (filter: SessionFilter, dir: string) => filter.accounts.some((a) => same(a, dir));

/** Whether a session (of the own account unless `s.account`) passes `filter`; `background` is how it ran, if in the background. */
export function passesFilter(s: SessionSummary, filter: SessionFilter, own: string, cwd: string, background: SessionBackground | undefined): boolean {
  if (!accountChosen(filter, s.account ?? own)) return false;
  if (filter.folders !== "all") {
    // The project folder of the transcript: the same slug in every account's projects.
    const here = basename(dirname(s.path)) === projectSlug(cwd);
    if (here !== (filter.folders === "this")) return false;
  }
  if (filter.background === "only") return background !== undefined;
  if (filter.background === "hide") return background === undefined;
  return true;
}
