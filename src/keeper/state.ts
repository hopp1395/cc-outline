import { lastActive, type SessionSummary } from "../transcript/sessions.js";
import type { RunningSession } from "../transcript/trash.js";

/**
 * Where a session stands for the keeper: Claude waits for the user (a permission, a question), works, is idle
 * (waits for the next prompt), or the session runs nowhere any more.
 */
export type KeeperState = "waiting" | "busy" | "idle" | "ended";

/** The order of the keeper's groups, top to bottom: what needs the user first. */
export const KEEPER_STATES: readonly KeeperState[] = ["waiting", "busy", "idle", "ended"];

/** The group separators of the keeper's list. */
export const KEEPER_GROUPS: Record<KeeperState, string> = { waiting: "Waiting", busy: "Working", idle: "Idle", ended: "Ended" };

/** What the row says after its age: "waiting 3m", "idle 12m". */
export const KEEPER_STATE_TEXT: Record<KeeperState, string> = { waiting: "waiting", busy: "working", idle: "idle", ended: "ended" };

/**
 * A session's state. One of this machine's: what its Claude Code says in `~/.claude/sessions/<pid>.json` (`running`;
 * without a status, before Claude Code 2.1.283, it counts as idle), ended without a process. A remote one: what
 * claude.ai lists (`requires_action` or a pending request waits, `running` works); a worker no longer connected has ended.
 */
export function keeperState(s: SessionSummary, running?: RunningSession): KeeperState {
  if (s.remote) {
    const { workerStatus, connectionStatus, pending } = s.remote;
    if (workerStatus === "requires_action" || pending) return "waiting";
    if (connectionStatus !== undefined && connectionStatus !== "connected") return "ended";
    return workerStatus === "running" ? "busy" : "idle";
  }
  if (!running) return "ended";
  return running.activity === "waiting" ? "waiting" : running.activity === "busy" ? "busy" : "idle";
}

/** A session in the keeper's list. */
export interface KeeperEntry {
  /** `sessionKey`: the id, another account's with its folder. */
  key: string;
  session: SessionSummary;
  state: KeeperState;
  /** Since when it is in this state (ms): first seen with it, else its last write. */
  since: number;
  running?: RunningSession;
}

/** When each session was first seen in its state, by key: the keeper keeps it between reads. */
export type SeenStates = Map<string, { state: KeeperState; since: number }>;

const activeAt = (s: SessionSummary) => {
  const at = lastActive(s);
  const ms = at ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * The keeper's list: the sessions that run (this machine's in a Claude Code, remote ones still connected) and those
 * last written since `dayStart` (today), grouped by state (`KEEPER_STATES`). The waiting ones come oldest first (the
 * longest waiting on top); the others newest first. `seen` keeps since when each was in its state; it is updated in
 * place and loses the sessions no longer listed.
 */
export function keeperEntries(
  sessions: SessionSummary[],
  running: Map<string, RunningSession>,
  keyOf: (s: SessionSummary) => string,
  seen: SeenStates,
  now: number,
  dayStart: number,
): KeeperEntry[] {
  const entries: KeeperEntry[] = [];
  const listed = new Set<string>();
  for (const session of sessions) {
    const key = keyOf(session);
    const run = running.get(key);
    const state = keeperState(session, run);
    const at = activeAt(session);
    const live = state !== "ended" && (run !== undefined || session.remote !== undefined);
    // A remote session claude.ai still lists counts as running only while it is not idle for days.
    if (!(run !== undefined || (live && state !== "idle") || (at !== undefined && at >= dayStart))) continue;
    listed.add(key);
    const before = seen.get(key);
    const since = before?.state === state ? before.since : before ? now : (at ?? now);
    seen.set(key, { state, since });
    entries.push({ key, session, state, since, running: run });
  }
  for (const key of [...seen.keys()]) if (!listed.has(key)) seen.delete(key);
  const rank = (e: KeeperEntry) => KEEPER_STATES.indexOf(e.state);
  return entries.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.state === "waiting") return a.since - b.since;
    return (activeAt(b.session) ?? 0) - (activeAt(a.session) ?? 0);
  });
}

/**
 * A stand-in for a session that runs in a Claude Code but was not read (no prompt yet, or not written since today):
 * its id, name and folder, from `~/.claude/sessions/<pid>.json`, and where its transcript will be.
 */
export function runningStandIn(id: string, run: RunningSession, path: string, account?: string): SessionSummary {
  return { id, path, title: run.name, cwd: run.cwd, prompts: [], plans: [], files: [], ...(account ? { account } : {}) };
}

/** A short age: 12s, 3m, 2h, 1d. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The entry `n` goes to from `from` (an index of `entries`): the waiting ones first (the longest waiting first, as
 * listed), then those that just finished (`fresh`, the one finished first first), round and round; undefined while
 * none of them is listed.
 */
export function nextWaiting(entries: KeeperEntry[], from: number, fresh: (e: KeeperEntry) => boolean = () => false): number | undefined {
  const waiting = entries.flatMap((e, i) => (e.state === "waiting" ? [i] : []));
  const finished = entries
    .flatMap((e, i) => (e.state === "idle" && fresh(e) ? [i] : []))
    .sort((a, b) => entries[a]!.since - entries[b]!.since);
  const order = [...waiting, ...finished];
  if (order.length === 0) return undefined;
  const at = order.indexOf(from);
  return order[(at + 1) % order.length];
}

/**
 * The sessions that just finished, by key, with when their mark stops blinking: a session the keeper saw go from
 * working or waiting to idle, unseen since. Seen: selected while the keeper has the focus; one selected as it finished
 * blinks a moment anyway (`short`).
 */
export type FreshIdle = Map<string, { until: number; short: boolean }>;

/**
 * `fresh` after the keeper read `entries`, whose states before were `before`: a session that went from working or
 * waiting to idle blinks until `long` (`short` when it is `selected` with the keeper focused); one no longer idle or
 * listed drops out. Returns the same map when nothing changed.
 */
export function updateFresh(
  fresh: FreshIdle,
  before: Map<string, KeeperState>,
  entries: KeeperEntry[],
  now: number,
  selected: string | undefined,
  focused: boolean,
  times: { long: number; short: number },
): FreshIdle {
  let next = fresh;
  const change = () => (next === fresh ? (next = new Map(fresh)) : next);
  const listed = new Set(entries.map((e) => e.key));
  for (const e of entries) {
    const was = before.get(e.key);
    if (e.state === "idle" && (was === "busy" || was === "waiting")) {
      const short = focused && e.key === selected;
      change().set(e.key, { until: now + (short ? times.short : times.long), short });
    } else if (e.state !== "idle" && fresh.has(e.key)) change().delete(e.key);
  }
  for (const key of fresh.keys()) if (!listed.has(key)) change().delete(key);
  return next;
}
