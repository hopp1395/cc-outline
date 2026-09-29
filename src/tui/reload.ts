import type { EventEmitter } from "node:events";
import { useInput, useStdin, type Key } from "ink";
import { createContext, useContext, useEffect, useRef } from "react";

/**
 * F5 as terminals send it: `ESC[15~` (xterm, Windows Terminal, tmux) or
 * `ESC[[E` (the Linux console, libuv). With a modifier it is `ESC[15;2~` etc.,
 * which does not count.
 */
const F5 = new Set(["\u001b[15~", "\u001b[[E"]);

/** Whether a raw input chunk is F5. */
export const isF5 = (raw: string) => F5.has(raw);

/** Ctrl+R, the other reload key, as `useInput` reports it; views skip it so their own `r` does not fire too. */
export const isReloadKey = (input: string, key: Key) => key.ctrl && input === "r";

/**
 * Calls `onReload` on F5 or Ctrl+R while `active`. Ink's `useInput` reports
 * every function key as an empty input with no flag set, so F5 is read from
 * the raw input its stdin context emits (untyped: `useStdin` returns the
 * whole context at runtime).
 */
export function useReloadKey(onReload: () => void, active: boolean): void {
  const handler = useRef(onReload);
  handler.current = onReload;
  const { internal_eventEmitter: emitter } = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };

  useEffect(() => {
    if (!active || !emitter) return;
    const onInput = (raw: string) => {
      if (isF5(raw)) handler.current();
    };
    emitter.on("input", onInput);
    return () => void emitter.off("input", onInput);
  }, [active, emitter]);

  useInput(
    (input, key) => {
      if (isReloadKey(input, key)) handler.current();
    },
    { isActive: active },
  );
}

export interface Reload {
  /** How often the view was reloaded; its data sources are read afresh whenever it grows. */
  count: number;
  /** While the reload runs, then shortly after it finished; undefined otherwise. */
  status?: "loading" | "done";
  /** The view has its data again. */
  done: () => void;
}

/** The reload of the surrounding view (F5), set by `App` per view. */
export const ReloadContext = createContext<Reload>({ count: 0, done: () => {} });

export const useReload = () => useContext(ReloadContext);

/** Runs `effect` on each reload of the surrounding view, not on mount. */
export function useOnReload(effect: (reload: Reload) => void | (() => void)): void {
  const reload = useReload();
  const run = useRef(effect);
  run.current = effect;
  // A view mounted again (project data reset) starts with the count so far.
  const mounted = useRef(reload.count);
  useEffect(() => {
    if (reload.count !== mounted.current) return run.current(reload);
  }, [reload.count]);
}
