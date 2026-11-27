import { useInput } from "ink";
import { useEffect, useState } from "react";
import { TIMING } from "../timing.js";
import { useFocused } from "./focus.js";

/**
 * Whether a blinking mark is in its off phase now: while `active`, re-renders at each change of phase. The phase comes
 * from the clock, so every mark blinks in step.
 */
export function useBlinkOff(active: boolean): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setTick((n) => n + 1);
        next();
      }, TIMING.blink - (Date.now() % TIMING.blink));
    };
    next();
    return () => clearTimeout(timer);
  }, [active]);
  return active && Math.floor(Date.now() / TIMING.blink) % 2 === 1;
}

/** Inputs that are no key: focus reports and mouse reports (a wheel step or a move keeps nothing typed). */
const notTyped = (input: string) => input === "[I" || input === "[O" || input.startsWith("[<");

/**
 * Whether the mark of where the keys go (a prompt line's cursor, a dialog's `›`) shows now. While `focused` (the
 * field has the keys) it blinks in step with the other marks, steady while the window has not the terminal's focus
 * (`useFocused`, the app's), and stays on for a phase after each key, so the cursor does not go out mid-word;
 * without the keys it does not show.
 */
export function useCaret(focused: boolean): boolean {
  const windowFocused = useFocused();
  const blinking = focused && windowFocused;
  const [typedAt, setTypedAt] = useState(0);
  const [, setTick] = useState(0);
  useInput(
    (input) => {
      if (!notTyped(input)) setTypedAt(Date.now());
    },
    { isActive: blinking },
  );
  // A render when the phase after a key ends, which need not be when the clock's phase changes.
  useEffect(() => {
    if (!blinking || !typedAt) return;
    const left = typedAt + TIMING.blink - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [typedAt, blinking]);
  const off = useBlinkOff(blinking);
  if (!focused) return false;
  if (!blinking) return true;
  return !off || Date.now() - typedAt < TIMING.blink;
}
