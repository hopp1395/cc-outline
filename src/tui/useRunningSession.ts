import { useEffect, useState } from "react";
import { runningSessions, type RunningSession } from "../transcript/trash.js";
import { TIMING } from "../timing.js";

const same = (a: RunningSession | undefined, b: RunningSession | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.pid === b.pid && a.activity === b.activity && a.kind === b.kind && a.jobId === b.jobId);

/**
 * The Claude Code that runs session `id` now (`~/.claude/sessions/<pid>.json` with a live pid), checked every
 * `TIMING.activityPoll`; for a viewer of one session, which shows Claude working only while the session runs and
 * types its prompts into that Claude Code. Without an id, or while it runs nowhere: undefined.
 */
export function useRunningSession(id: string | undefined): RunningSession | undefined {
  const check = () => (id !== undefined ? runningSessions().get(id) : undefined);
  const [running, setRunning] = useState(check);
  useEffect(() => {
    const update = () => {
      const next = check();
      setRunning((before) => (same(before, next) ? before : next));
    };
    update();
    if (id === undefined) return;
    const timer = setInterval(update, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [id]);
  return running;
}
