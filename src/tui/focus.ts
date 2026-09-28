import { useInput, useStdout } from "ink";
import { createContext, useContext, useEffect, useState } from "react";
import { parseMouse } from "./mouse.js";

/** Terminal focus reporting (DECSET 1004): the terminal sends ESC[I on focus in and ESC[O on focus out. */
const ENABLE = "\u001b[?1004h";
const DISABLE = "\u001b[?1004l";
// Ink hands these sequences to useInput without the leading ESC and with no key flags set.
const FOCUS_IN = "[I";
const FOCUS_OUT = "[O";

/**
 * What an input says about the focus: a focus report, else any key or click
 * means the pane has it (a wheel step can reach a pane that has not).
 * Undefined when it says nothing.
 */
export function focusFromInput(input: string): boolean | undefined {
  if (input === FOCUS_IN) return true;
  if (input === FOCUS_OUT) return false;
  if (input.startsWith("[<")) return parseMouse(input).some((e) => e.kind === "click") || undefined;
  return true;
}

/**
 * Whether the viewer's pane has the keyboard focus. Focus reports are the
 * source, but not every terminal sends them (Windows Terminal 1.12 does not):
 * then a key or click in the viewer means focused, and a prompt typed in
 * Claude Code (`typedElsewhere`, its time) means the focus is there.
 */
export function useTerminalFocus(initial = true, typedElsewhere?: number): boolean {
  const { stdout } = useStdout();
  const [focused, setFocused] = useState(initial);

  useEffect(() => {
    stdout.write(ENABLE);
    const disable = () => stdout.write(DISABLE);
    // Also on exits that skip React cleanup, so the terminal stops reporting.
    process.on("exit", disable);
    return () => {
      process.off("exit", disable);
      disable();
    };
  }, [stdout]);

  useEffect(() => {
    if (typedElsewhere !== undefined) setFocused(false);
  }, [typedElsewhere]);

  useInput((input) => {
    const next = focusFromInput(input);
    if (next !== undefined) setFocused(next);
  });

  return focused;
}

export const FocusContext = createContext(true);

export const useFocused = () => useContext(FocusContext);

/** Key that moves the terminal focus between the panes: Windows Terminal's default or tmux's prefix binding. */
export function paneSwitchKey(direction: "left" | "right"): string {
  const arrow = direction === "left" ? "←" : "→";
  return process.env.TMUX ? `ctrl+b ${arrow}` : `alt+${arrow}`;
}
