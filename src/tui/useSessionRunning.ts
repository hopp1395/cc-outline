import { useEffect, useState } from "react";
import { runningSessions } from "../transcript/trash.js";
import { TIMING } from "../timing.js";

/**
 * Whether session `id` runs in a Claude Code now (`~/.claude/sessions/<pid>.json` with a live pid), checked every
 * `TIMING.activityPoll`; for a viewer of one session, which shows Claude working only while the session runs. Without an id: false.
 */
export function useSessionRunning(id: string | undefined): boolean {
  const check = () => id !== undefined && runningSessions().has(id);
  const [running, setRunning] = useState(check);
  useEffect(() => {
    if (id === undefined) return setRunning(false);
    setRunning(check());
    const timer = setInterval(() => setRunning(check()), TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [id]);
  return running;
}
