import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountsHome } from "./addAccount.js";
import { readJson, writeJson } from "./transcript/locate.js";
import { isAlive } from "./viewer.js";

/**
 * A session viewer, a viewer of one session in a window of its own (`cco watch --session`, `--remote`): the chat only, with a prompt
 * line for a remote session while steer remote is on. Any number may run per session; each registers itself so
 * Sessions can count them (◎) and bring one to the front.
 */
export interface SessionViewerInfo {
  pid: number;
  /** The local session it was opened for; its chain may have gone on under another id since. */
  sessionId?: string;
  /** The Remote Control session it was opened for. */
  remoteId?: string;
  /** The config folder (account) it reads. */
  configDir?: string;
  /** The Windows Terminal or tmux window it runs in (`viewerWindow`), if cco opened it. */
  window?: string;
  /** When it started (ms). */
  started: number;
}

/**
 * Where session viewers register: below the default `~/.claude`, whatever account a viewer reads, so the Sessions
 * view of every account sees all of them.
 */
export const sessionViewersDir = () => join(accountsHome.get(), ".claude", "cco", "viewers");

/** Where they registered before (as observers); the doctor cleans it up. */
export const legacyObserversDir = () => join(accountsHome.get(), ".claude", "cco", "observers");

const viewerFile = (pid: number) => join(sessionViewersDir(), `${pid}.json`);

/** A window name of its own for a new session viewer, so it can be brought to the front later. */
export const viewerWindow = () => `cco-view-${randomBytes(4).toString("hex")}`;

/** Records this process as a session viewer until it exits. */
export function registerSessionViewer(info: Omit<SessionViewerInfo, "pid" | "started">): void {
  const file = viewerFile(process.pid);
  mkdirSync(sessionViewersDir(), { recursive: true });
  writeJson(file, { ...info, pid: process.pid, started: Date.now() } satisfies SessionViewerInfo);
  process.on("exit", () => rmSync(file, { force: true }));
}

function readViewers(): { file: string; info?: SessionViewerInfo }[] {
  let names: string[];
  try {
    names = readdirSync(sessionViewersDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = join(sessionViewersDir(), name);
    const info = readJson<SessionViewerInfo>(file);
    return { file, info: info && typeof info === "object" && typeof info.pid === "number" && typeof info.started === "number" ? info : undefined };
  });
}

/** The session viewers that run, the newest last; registrations of dead processes are ignored. */
export function runningSessionViewers(): SessionViewerInfo[] {
  return readViewers()
    .flatMap(({ info }) => (info && isAlive(info.pid) ? [info] : []))
    .sort((a, b) => a.started - b.started);
}

/** Removes the registrations of session viewers that no longer run (and files that are none); returns how many. */
export function removeStaleSessionViewers(): number {
  let removed = 0;
  for (const { file, info } of readViewers()) {
    if (info && isAlive(info.pid)) continue;
    rmSync(file, { force: true });
    removed++;
  }
  return removed;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** What a viewer is matched against: a local session (its ids along the chain, in `configDir`) or a remote one. */
export type ViewedSession = { ids: string[]; configDir: string } | { remoteId: string };

/** The running viewers of `session`, the newest last. */
export function viewersOf(viewers: SessionViewerInfo[], session: ViewedSession): SessionViewerInfo[] {
  if ("remoteId" in session) return viewers.filter((o) => o.remoteId === session.remoteId);
  return viewers.filter(
    (o) => o.sessionId !== undefined && session.ids.includes(o.sessionId) && (!o.configDir || samePath(o.configDir, session.configDir)),
  );
}
