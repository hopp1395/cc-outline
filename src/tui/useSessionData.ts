import { useEffect, useRef, useState } from "react";
import { describeRemoteError, RemoteSessions } from "../remote/index.js";
import { lastActive, SessionIndex, type SessionSummary } from "../transcript/sessions.js";
import { runningSessions, type RunningSession } from "../transcript/trash.js";
import { inClaudeDir } from "../transcript/locate.js";
import { useReload } from "./reload.js";
import { TIMING } from "../timing.js";
import { runningSessionViewers, type SessionViewerInfo } from "../sessionViewers.js";

/** How often the sessions are re-read while a view shows them; only changed files are parsed again. */
export const REFRESH_MS = 3000;

/**
 * What a session is known by in the list (selection, marks, scroll positions, running): its id, for another
 * account's the folder too, since a session continued there may keep its id.
 */
export const sessionKey = (s: Pick<SessionSummary, "id" | "account">) => (s.account ? `${s.account}|${s.id}` : s.id);

/**
 * The sessions of the project (or, with `all`, of every project) and which of
 * them run in a Claude Code process, read while `visible` and refreshed every
 * few seconds; with `accounts` (their config folders) also those of the other
 * accounts, read after this one's. The first scan fills the list as it goes; `progress` counts the
 * transcripts read so far. `refresh` rescans at once. A reload of the view
 * (F5) reads every transcript again with new indexes; the list stays until
 * that scan is done. With `since`, only transcripts written since then are
 * read; when it changes (load more), the list also stays until the scan is done. `ownAll` is `all` for this
 * viewer's own folder, which is always read: the active session shows whatever the filter says.
 */
export function useSessions(cwd: string, visible: boolean, all: boolean, since: number | undefined, accounts: string[], ownAll = all) {
  // One index per config folder, "" for this viewer's own.
  const indexes = useRef(new Map<string, SessionIndex>());
  const reload = useReload();
  const loaded = useRef(reload.count);
  const sinceRef = useRef(since);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const [sessions, setSessions] = useState<SessionSummary[]>();
  // The last finished scan read every transcript (no `since`).
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const folders = accounts.join("\n");

  useEffect(() => {
    if (!visible) return;
    const fresh = reload.count !== loaded.current;
    loaded.current = reload.count;
    if (fresh) indexes.current = new Map();
    const extending = since !== sinceRef.current;
    sinceRef.current = since;
    // The indexes of the folders shown; those of accounts no longer shown are dropped.
    const current = ["", ...accounts].map((dir) => {
      let index = indexes.current.get(dir);
      if (!index) indexes.current.set(dir, (index = new SessionIndex(dir || undefined)));
      return index;
    });
    for (const dir of indexes.current.keys()) if (dir && !accounts.includes(dir)) indexes.current.delete(dir);
    let cancelled = false;
    let busy = false;
    let first = true;
    let reloading = fresh;
    // Also when the scan fails or stops early: F5 is refused while a reload runs.
    const finish = () => {
      if (!reloading) return;
      reloading = false;
      reload.done();
    };
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        const found: SessionSummary[] = [];
        for (const [i, index] of current.entries()) {
          const result = await index.scan((i === 0 ? ownAll : all) ? undefined : cwd, (partial, done, total) => {
            // Only the first scan shows partial lists; later ones just update the finished list.
            // A reload keeps the list and shows only the progress.
            if (cancelled || !first) return;
            if (!reloading && !extending) setSessions(byLastActive([...found, ...partial]));
            setProgress({ done, total });
          }, since);
          if (cancelled) return;
          found.push(...result);
        }
        first = false;
        setSessions(current.length > 1 ? byLastActive(found) : found);
        setComplete(since === undefined);
        setProgress(undefined);
      } finally {
        busy = false;
        finish();
      }
    };
    scanRef.current = scan;
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      finish();
    };
  }, [cwd, visible, all, ownAll, reload.count, since, folders]);

  return { sessions, progress, complete, refresh: () => void scanRef.current() };
}

/** Whether two reads of the remote sessions show the same, so the list is not rebuilt for nothing. */
const sameRemote = (a: SessionSummary[], b: SessionSummary[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.title === b[i]!.title && s.modified === b[i]!.modified && s.remote?.workerStatus === b[i]!.remote?.workerStatus && s.remote?.connectionStatus === b[i]!.remote?.connectionStatus && s.remote?.pending?.requestId === b[i]!.remote?.pending?.requestId);

const NO_REMOTE: { sessions: SessionSummary[]; error?: string } = { sessions: [] };

/**
 * The remote sessions of this account, listed every few seconds while the view is `visible` and `enabled` (the
 * `remoteApi` setting and not hidden by the filter); `error` says why a read failed, the last list stays. F5 reads again.
 */
export function useRemoteSessions(visible: boolean, enabled: boolean): { sessions: SessionSummary[]; error?: string } {
  const reload = useReload();
  const [state, setState] = useState(NO_REMOTE);
  useEffect(() => {
    if (!visible || !enabled) return;
    const api = new RemoteSessions();
    let cancelled = false;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const sessions = await api.list();
        if (!cancelled) setState((prev) => (!prev.error && sameRemote(prev.sessions, sessions) ? prev : { sessions }));
      } catch (err) {
        if (!cancelled) setState((prev) => ({ sessions: prev.sessions, error: describeRemoteError(err) }));
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, enabled, reload.count]);
  return enabled ? state : NO_REMOTE;
}

/** The sessions of several accounts in one list, oldest first, like each index gives them. */
export const byLastActive = (sessions: SessionSummary[]) => sessions.sort((a, b) => (lastActive(a) ?? "").localeCompare(lastActive(b) ?? ""));

const sameRunning = (a: Map<string, RunningSession>, b: Map<string, RunningSession>) =>
  a.size === b.size &&
  [...a].every(([id, r]) => {
    const o = b.get(id);
    return o !== undefined && o.pid === r.pid && o.activity === r.activity && o.name === r.name;
  });

/**
 * The sessions running in a Claude Code process and what it does in each, by `sessionKey`, read every second while
 * `visible`, also in the config folders of the other `accounts` shown; the map only changes when one of them does,
 * so the memoized header stays.
 */
export function useRunning(visible: boolean, accounts: string[]): Map<string, RunningSession> {
  const [running, setRunning] = useState<Map<string, RunningSession>>(() => new Map());
  const folders = accounts.join("\n");
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const next = runningSessions();
      for (const dir of accounts) for (const [id, r] of inClaudeDir(dir, runningSessions)) next.set(sessionKey({ id, account: dir }), r);
      setRunning((prev) => (sameRunning(prev, next) ? prev : next));
    };
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [visible, folders]);
  return running;
}

/**
 * This machine's sessions `read` with the remote ones that are not among them: a session of this machine names the
 * id claude.ai lists it under (`bridge-session` entries); failing that, a remote one may name the local id somewhere in
 * its data. `connected` holds the ids of this machine's sessions that are remote too (⇄).
 */
export function mergeRemote(read: SessionSummary[], remote: SessionSummary[]): { merged: SessionSummary[]; connected: Set<string> } {
  const local = new Set(read.filter((s) => !s.account).map((s) => s.id));
  const byBridge = new Map<string, string>();
  for (const s of read) if (!s.account) for (const id of s.bridgeIds ?? []) byBridge.set(id, s.id);
  const twins = new Set<string>();
  const alone = remote.filter((r) => {
    const twin = [...(byBridge.has(r.id) ? [byBridge.get(r.id)!] : []), ...(r.remote?.refs?.filter((id) => local.has(id)) ?? [])];
    for (const id of twin) twins.add(id);
    return twin.length === 0;
  });
  return { merged: alone.length ? byLastActive([...read, ...alone]) : read, connected: twins };
}

/** The session viewers that run, read every second while `visible`; the list only changes when they do. */
export function useSessionViewers(visible: boolean): SessionViewerInfo[] {
  const [viewers, setViewers] = useState<SessionViewerInfo[]>([]);
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const next = runningSessionViewers();
      setViewers((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [visible]);
  return viewers;
}
