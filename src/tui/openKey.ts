import type { EventEmitter } from "node:events";
import { useStdin } from "ink";
import { useEffect, useRef } from "react";

/**
 * Ctrl+Enter as terminals send it: a line feed (Windows Terminal, xterm), or
 * with extended keys `ESC[13;5u` (kitty protocol) or `ESC[27;5;13~`
 * (modifyOtherKeys). Plain Enter is a carriage return.
 */
const CTRL_ENTER = new Set(["\n", "\u001b[13;5u", "\u001b[27;5;13~"]);

/** Whether a raw input chunk is Ctrl+Enter. */
export const isCtrlEnter = (raw: string) => CTRL_ENTER.has(raw);

/**
 * Calls `handler` on Ctrl+Enter while `active`. Ink's `useInput` reports a
 * line feed as an empty input with no flag set, so it is read from the raw
 * input, like F5 in `useReloadKey`.
 */
export function useCtrlEnter(handler: () => void, active: boolean): void {
  const current = useRef(handler);
  current.current = handler;
  const { internal_eventEmitter: emitter } = useStdin() as unknown as { internal_eventEmitter?: EventEmitter };

  useEffect(() => {
    if (!active || !emitter) return;
    const onInput = (raw: string) => {
      if (isCtrlEnter(raw)) current.current();
    };
    emitter.on("input", onInput);
    return () => void emitter.off("input", onInput);
  }, [active, emitter]);
}

/** Longest gap between the two clicks of a double click. */
export const DOUBLE_CLICK_MS = 400;

/** Tells whether a click on `index` at `now` completes a double click on the same entry; a completed one does not start the next. */
export function doubleClicks(gap = DOUBLE_CLICK_MS): (index: number, now?: number) => boolean {
  let last: { index: number; at: number } | undefined;
  return (index, now = Date.now()) => {
    const double = last !== undefined && last.index === index && now - last.at <= gap;
    last = double ? undefined : { index, at: now };
    return double;
  };
}
