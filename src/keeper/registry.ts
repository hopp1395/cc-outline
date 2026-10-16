import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountsHome } from "../addAccount.js";
import { readJson, writeJson } from "../transcript/locate.js";
import { isAlive } from "../viewer.js";

/** The keeper that runs (`cco keeper`): one per machine, whatever account it was started from. */
export interface KeeperInfo {
  pid: number;
  /** The config folder (account) it was started from. */
  configDir?: string;
  /** The Windows Terminal or tmux window it runs in, if cco opened it. */
  window?: string;
  /** When it started (ms). */
  started: number;
}

/** Where the keeper registers: below the default `~/.claude`, so a start from any account finds it. */
export const keeperFile = () => join(accountsHome.get(), ".claude", "cco", "keeper.json");

/** The keeper that runs, if any; a registration of a process that is gone counts as none. */
export function runningKeeper(): KeeperInfo | undefined {
  const info = readJson<KeeperInfo>(keeperFile());
  return info && typeof info === "object" && typeof info.pid === "number" && isAlive(info.pid) ? info : undefined;
}

/** Records this process as the keeper until it exits. */
export function registerKeeper(info: Omit<KeeperInfo, "pid" | "started">): void {
  const file = keeperFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { ...info, pid: process.pid, started: Date.now() } satisfies KeeperInfo);
  process.on("exit", () => {
    // Only its own: a keeper started after it (this one hung) may have taken the file.
    if (readJson<KeeperInfo>(file)?.pid === process.pid) rmSync(file, { force: true });
  });
}

/** A session the keeper is asked to select: one of this machine's (its id in config folder `configDir`) or a remote one. */
export interface KeeperSelect {
  id: string;
  /** The config folder (account) of a session of this machine; none for a remote one. */
  configDir?: string;
  remote?: boolean;
}

/** Where the running keeper is asked to select a session (Sessions: Watch it in the keeper, /cco:keeper). */
export const keeperControlFile = () => join(accountsHome.get(), ".claude", "cco", "keeper-control.json");

/** Asks the running keeper to select `select`. */
export function requestKeeperSelect(select: KeeperSelect): void {
  const file = keeperControlFile();
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { ...select, at: Date.now() });
}

/** The latest request to the keeper, if it is a valid one. */
export function readKeeperRequest(): (KeeperSelect & { at: number }) | undefined {
  const request = readJson<KeeperSelect & { at: number }>(keeperControlFile());
  return request && typeof request === "object" && typeof request.id === "string" && typeof request.at === "number" ? request : undefined;
}
