import { useStdout } from "ink";
import { useEffect, useState } from "react";

/** The window title for a session title (or, without one, the project folder); "cco" only when there is neither. */
export function terminalTitle(title: string): string {
  // Control characters would end the OSC sequence early or reach the terminal raw.
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return clean || "cco";
}

/** What Claude Code puts before its title: two half circles in turn while it works, a star when it waits. */
export const WORKING_FRAMES = ["◐", "◑"];
export const IDLE_MARK = "✳";
/** How long each half circle shows, as in Claude Code. */
export const WORKING_FRAME_MS = 960;

/** The title with Claude Code's status mark: `frame` of the working marks, or the idle one; none without a status. */
export function titleWithStatus(title: string, status: "working" | "idle" | undefined, frame = 0): string {
  const text = terminalTitle(title);
  if (status === undefined) return text;
  const mark = status === "working" ? WORKING_FRAMES[frame % WORKING_FRAMES.length] : IDLE_MARK;
  return `${mark} ${text}`;
}

/**
 * Sets the terminal's window and tab title (OSC 0) to `title`, so the
 * viewer's tab and a window of its own show the session instead of "cco".
 * With a `status`, it starts with Claude Code's mark: ◐/◑ in turn while the
 * session's last turn runs, ✳ otherwise. Windows Terminal takes it over the
 * `--title` of the tab unless the profile sets `suppressApplicationTitle`.
 */
export function useTerminalTitle(title: string, status?: "working" | "idle"): void {
  const { stdout } = useStdout();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (status !== "working") return;
    const timer = setInterval(() => setFrame((f) => f + 1), WORKING_FRAME_MS);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => {
    stdout.write(`\u001b]0;${titleWithStatus(title, status, frame)}\u0007`);
  }, [stdout, title, status, frame]);
}
