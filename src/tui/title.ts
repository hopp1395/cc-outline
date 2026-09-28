import { useStdout } from "ink";
import { useEffect } from "react";

/** The window title for a session title (or, without one, the project folder); "cco" only when there is neither. */
export function terminalTitle(title: string): string {
  // Control characters would end the OSC sequence early or reach the terminal raw.
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return clean || "cco";
}

/**
 * Sets the terminal's window and tab title (OSC 0) to `title`, so the
 * viewer's tab and a window of its own show the session instead of "cco".
 * Windows Terminal takes it over the `--title` of the tab unless the profile
 * sets `suppressApplicationTitle`.
 */
export function useTerminalTitle(title: string): void {
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write(`\u001b]0;${terminalTitle(title)}\u0007`);
  }, [stdout, title]);
}
