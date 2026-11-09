import { useCallback, useSyncExternalStore } from "react";
import type { Account } from "../account.js";
import { quotaOf, readQuotaFile, refreshQuota, type Quota } from "../remote/quota.js";
import { readRateLimits } from "../remote/usage.js";
import { TIMING } from "../timing.js";
import { useSetting } from "./useSetting.js";

/** What the viewer shows of the account's 5-hour and 7-day windows, or why it shows none (`reason`). */
export interface QuotaState extends Quota {
  /** None is read: the remote API setting is off, the account is an API profile, or there is no account. */
  reason?: "off" | "api" | "none";
  /** Asks claude.ai at once (F5 in Settings). */
  refresh: () => void;
}

/** One account's windows, read for all views of this process by one timer while any of them shows them. */
interface Store {
  listeners: Set<() => void>;
  state: Quota;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
}

const stores = new Map<string, Store>();

/** The windows as kept; with the minute, so the times left count down. */
const read = (dir: string, now = Date.now()): Quota & { minute: number } => ({ ...quotaOf(readQuotaFile(dir), readRateLimits(dir), now), minute: Math.floor(now / 60_000) });

/** Sets what the store shows, telling the views only of a change. */
function show(store: Store, state: Quota): void {
  if (JSON.stringify(state) === JSON.stringify(store.state)) return;
  store.state = state;
  for (const listener of store.listeners) listener();
}

function storeOf(dir: string): Store {
  let store = stores.get(dir);
  if (!store) {
    store = { listeners: new Set(), state: read(dir), busy: false };
    stores.set(dir, store);
  }
  return store;
}

function check(dir: string, store: Store, force = false): void {
  // Between reads the windows are read from the file (another viewer's read), the times left count down and old ones dim.
  show(store, read(dir));
  if (store.busy) return;
  store.busy = true;
  void refreshQuota(dir, Date.now(), force)
    .then(() => show(store, read(dir)))
    .finally(() => {
      store.busy = false;
    });
}

function subscribe(dir: string, listener: () => void): () => void {
  const store = storeOf(dir);
  store.listeners.add(listener);
  if (!store.timer) {
    check(dir, store);
    store.timer = setInterval(() => check(dir, store), TIMING.quotaCheck);
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size > 0) return;
    clearInterval(store.timer);
    stores.delete(dir);
  };
}

const NONE: Quota = { stale: false };
const noop = () => () => {};

/**
 * The 5-hour and 7-day windows of `account` (the one the viewer shows), read from claude.ai with the remote API setting;
 * all views of the process and all viewers of the account share the reads.
 */
export function useQuota(account: Account | undefined): QuotaState {
  const [remoteApi] = useSetting("remoteApi");
  const reason = !account ? "none" : account.api ? "api" : !remoteApi ? "off" : undefined;
  const dir = reason ? undefined : account!.dir;
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => (dir ? subscribe(dir, listener) : noop()), [dir]),
    () => (dir ? storeOf(dir).state : NONE),
  );
  const refresh = useCallback(() => {
    if (dir) check(dir, storeOf(dir), true);
  }, [dir]);
  return { ...state, ...(reason && { reason }), refresh };
}
