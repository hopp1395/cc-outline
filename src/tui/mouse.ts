import { useInput, useStdout } from "ink";
import { createContext, useContext, useEffect } from "react";

/**
 * Mouse reporting: button presses, releases and moves with a button held
 * (DECSET 1002, which includes the wheel) in SGR encoding (1006). While it is
 * on, the terminal leaves clicks and drags to the viewer, which selects text
 * in the preview itself (`Preview`); Windows Terminal still selects with
 * Shift+drag.
 */
const ENABLE = "\u001b[?1002h\u001b[?1006h";
const DISABLE = "\u001b[?1002l\u001b[?1006l";

export interface MouseEvent {
  /** `click` is a press of the left button, `drag` a move while it is held, `release` letting it go; `right` a press of the right button. */
  kind: "click" | "drag" | "release" | "right" | "wheel";
  /** Wheel: -1 up, 1 down. */
  delta: number;
  /** Zero-based cell the event happened in. */
  x: number;
  y: number;
}

// Ink hands SGR reports to useInput without the leading ESC, one per call: "[<0;12;5M".
const SGR = /\[<(\d+);(\d+);(\d+)([Mm])/g;

/** The mouse events in `input`: the left button's presses, drags and releases, the right button's presses and wheel steps; the rest is left out. */
export function parseMouse(input: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const [, code, col, row, final] of input.matchAll(SGR)) {
    const button = Number(code);
    const x = Number(col) - 1;
    const y = Number(row) - 1;
    // Bits 4, 8 and 16 are Shift, Alt and Ctrl; bit 32 marks motion.
    const base = button & ~(4 | 8 | 16 | 32);
    const moved = (button & 32) !== 0;
    if (base === 64 || base === 65) {
      if (!moved) events.push({ kind: "wheel", delta: base === 64 ? -1 : 1, x, y });
    } else if (base === 0) {
      events.push({ kind: final === "m" ? "release" : moved ? "drag" : "click", delta: 0, x, y });
    } else if (base === 2 && final === "M" && !moved) {
      events.push({ kind: "right", delta: 0, x, y });
    }
  }
  return events;
}

/** Whether mouse events are for this part of the screen: its view is shown, no dialog is open, and the mouse setting is on. */
export const MouseContext = createContext(false);

/** Turns mouse reporting on while `enabled`, and off again on exit. */
export function useMouseReporting(enabled: boolean): void {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!enabled) return;
    stdout.write(ENABLE);
    const disable = () => stdout.write(DISABLE);
    // Also on exits that skip React cleanup, so the shell does not receive mouse reports afterwards.
    process.on("exit", disable);
    return () => {
      process.off("exit", disable);
      disable();
    };
  }, [stdout, enabled]);
}

/** Calls `handler` for each mouse event while the surrounding view takes the mouse (and `active`). */
export function useMouse(handler: (event: MouseEvent) => void, active = true): void {
  const enabled = useContext(MouseContext);
  useInput(
    (input) => {
      if (!input.startsWith("[<")) return;
      for (const event of parseMouse(input)) handler(event);
    },
    { isActive: enabled && active },
  );
}
