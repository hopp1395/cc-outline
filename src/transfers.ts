import { inClaudeDir, readJson, transfersFile, writeJson } from "./transcript/locate.js";

/** The other side of a session continued in another account: that account's folder and email, and the session's id there. */
export interface TransferEnd {
  /** The config folder of the account. */
  dir: string;
  email: string;
  /** The session's id in that account (a copy may have got a new one). */
  id: string;
  /** Epoch ms. */
  at: number;
}

/** What a project's `<slug>.accounts.json` keeps per session id. */
export interface Transfer {
  /** Copies of the session continued in other accounts, oldest first. */
  to?: TransferEnd[];
  /** The session this one is a copy of, in another account. */
  from?: TransferEnd;
}

/** Sessions kept per project; the ones recorded longest ago are dropped. */
const MAX_TRANSFERS = 500;

const isEnd = (v: unknown): v is TransferEnd => {
  const e = v as Partial<TransferEnd> | null;
  return !!e && typeof e === "object" && typeof e.dir === "string" && typeof e.email === "string" && typeof e.id === "string" && typeof e.at === "number";
};

/** The transfers of the project `cwd` in this process's config folder, by session id. */
export function readTransfers(cwd: string): Record<string, Transfer> {
  const stored = readJson<Record<string, unknown>>(transfersFile(cwd));
  const result: Record<string, Transfer> = {};
  for (const [id, value] of Object.entries(stored ?? {})) {
    const raw = value as { to?: unknown; from?: unknown } | null;
    if (!raw || typeof raw !== "object") continue;
    const to = Array.isArray(raw.to) ? raw.to.filter(isEnd) : [];
    const entry: Transfer = { ...(to.length ? { to } : {}), ...(isEnd(raw.from) ? { from: raw.from } : {}) };
    if (entry.to || entry.from) result[id] = entry;
  }
  return result;
}

function update(cwd: string, id: string, change: (t: Transfer) => Transfer): void {
  const all = readTransfers(cwd);
  const next = change(all[id] ?? {});
  delete all[id];
  all[id] = next;
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_TRANSFERS))) delete all[old];
  writeJson(transfersFile(cwd), all);
}

/**
 * Records that the session `from.id` of the account in `from.dir` went on as `to.id` in the account in `to.dir`:
 * in both folders' state, so each side's Sessions view names the other.
 */
export function recordTransfer(cwd: string, from: Omit<TransferEnd, "at">, to: Omit<TransferEnd, "at">, at = Date.now()): void {
  inClaudeDir(from.dir, () => update(cwd, from.id, (t) => ({ ...t, to: [...(t.to ?? []), { ...to, at }] })));
  inClaudeDir(to.dir, () => update(cwd, to.id, (t) => ({ ...t, from: { ...from, at } })));
}
