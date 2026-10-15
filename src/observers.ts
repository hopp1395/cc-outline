import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountsHome } from "./addAccount.js";
import { readJson, writeJson } from "./transcript/locate.js";
import { isAlive } from "./viewer.js";

/**
 * An observer: a viewer of one session in a window of its own (`cco watch --session`, or `--remote … --observe`),
 * the chat only, read-only. Any number may run per session; each registers itself so Sessions can count them (◎)
 * and bring one to the front.
 */
export interface ObserverInfo {
  pid: number;
  /** The local session it was opened for; its chain may have gone on under another id since. */
  sessionId?: string;
  /** The Remote Control session it was opened for. */
  remoteId?: string;
  /** The config folder (account) it reads. */
  configDir?: string;
  /** The Windows Terminal or tmux window it runs in (`observerWindow`), if cco opened it. */
  window?: string;
  /** When it started (ms). */
  started: number;
}

/**
 * Where observers register: below the default `~/.claude`, whatever account an observer reads, so the Sessions view
 * of every account sees all of them.
 */
export const observersDir = () => join(accountsHome.get(), ".claude", "cco", "observers");

const observerFile = (pid: number) => join(observersDir(), `${pid}.json`);

/** A window name of its own for a new observer, so it can be brought to the front later. */
export const observerWindow = () => `cco-observe-${randomBytes(4).toString("hex")}`;

/** Records this process as an observer until it exits. */
export function registerObserver(info: Omit<ObserverInfo, "pid" | "started">): void {
  const file = observerFile(process.pid);
  mkdirSync(observersDir(), { recursive: true });
  writeJson(file, { ...info, pid: process.pid, started: Date.now() } satisfies ObserverInfo);
  process.on("exit", () => rmSync(file, { force: true }));
}

function readObservers(): { file: string; info?: ObserverInfo }[] {
  let names: string[];
  try {
    names = readdirSync(observersDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = join(observersDir(), name);
    const info = readJson<ObserverInfo>(file);
    return { file, info: info && typeof info === "object" && typeof info.pid === "number" && typeof info.started === "number" ? info : undefined };
  });
}

/** The observers that run, the newest last; registrations of dead processes are ignored. */
export function runningObservers(): ObserverInfo[] {
  return readObservers()
    .flatMap(({ info }) => (info && isAlive(info.pid) ? [info] : []))
    .sort((a, b) => a.started - b.started);
}

/** Removes the registrations of observers that no longer run (and files that are none); returns how many. */
export function removeStaleObservers(): number {
  let removed = 0;
  for (const { file, info } of readObservers()) {
    if (info && isAlive(info.pid)) continue;
    rmSync(file, { force: true });
    removed++;
  }
  return removed;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** What an observer is matched against: a local session (its ids along the chain, in `configDir`) or a remote one. */
export type ObservedSession = { ids: string[]; configDir: string } | { remoteId: string };

/** The running observers of `session`, the newest last. */
export function observersOf(observers: ObserverInfo[], session: ObservedSession): ObserverInfo[] {
  if ("remoteId" in session) return observers.filter((o) => o.remoteId === session.remoteId);
  return observers.filter(
    (o) => o.sessionId !== undefined && session.ids.includes(o.sessionId) && (!o.configDir || samePath(o.configDir, session.configDir)),
  );
}
