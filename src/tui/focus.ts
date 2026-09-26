import { useInput, useStdout } from "ink";
import { createContext, useContext, useEffect, useState } from "react";

/** Terminal focus reporting (DECSET 1004): the terminal sends ESC[I on focus in and ESC[O on focus out. */
const ENABLE = "\u001b[?1004h";
const DISABLE = "\u001b[?1004l";
// Ink hands these sequences to useInput without the leading ESC and with no key flags set.
const FOCUS_IN = "[I";
const FOCUS_OUT = "[O";

/**
 * Whether the viewer's pane has the keyboard focus. Terminals without focus
 * reporting never send an event, so the viewer then stays "focused".
 */
export function useTerminalFocus(initial = true): boolean {
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

  useInput((input) => {
    if (input === FOCUS_IN) setFocused(true);
    else if (input === FOCUS_OUT) setFocused(false);
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
