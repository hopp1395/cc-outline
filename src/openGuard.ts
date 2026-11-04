import { TIMING } from "./timing.js";

/** What an open did, by what it opened (`openOnce`'s key), and until when it stands for the next; `pending` while its promise runs. */
const recent = new Map<string, { until: number; result: unknown; pending: boolean }>();

/**
 * Runs `open` (a window, a tab, an app it starts) unless the same `key` ran within `TIMING.openGuard`, or still runs (a
 * promise): then it returns what that run returned, so the help line keeps its notice. A double click on a row, Enter
 * pressed twice or a repeating key opened two windows of the same; an open of something else runs at once.
 */
export function openOnce<T>(key: string, open: () => T): T {
  const now = Date.now();
  for (const [k, v] of recent) if (!v.pending && now >= v.until) recent.delete(k);
  const last = recent.get(key);
  if (last) return last.result as T;
  const result = open();
  const entry = { until: now + TIMING.openGuard, result: result as unknown, pending: false };
  if (result instanceof Promise) {
    entry.pending = true;
    // The guard runs on from when it finished: a second Enter in the meantime belongs to the same run.
    const settled = () => Object.assign(entry, { pending: false, until: Date.now() + TIMING.openGuard });
    result.then(settled, settled);
  }
  recent.set(key, entry);
  return result;
}

/** Forgets every open (tests: what one test opened is not in the way of the next). */
export function forgetOpens(): void {
  recent.clear();
}
