import { useEffect } from "react";
import { activeFile, claudeFile, controlFile, readActive, readJson, type ActiveSession } from "../transcript/locate.js";
import { watchFile } from "../transcript/tail.js";
import { isAlive, readControl } from "../viewer.js";
import type { Mode } from "./layout.js";

/** Grace period so a quick restart (end + start) doesn't close the viewer. */
const END_GRACE_MS = 1500;
/** How often the viewer checks that its Claude Code process still runs. */
const PROCESS_POLL_MS = 2000;

/**
 * Wires the viewer to its surroundings: switches view on requests from
 * `cco open`, and exits when the followed Claude Code session ends. With
 * `claudePid` only that process counts: its session ending or the process
 * being gone; other sessions of the project are left alone.
 * Only changes after the viewer started count, so stale state is ignored.
 */
export function useViewerControl(opts: {
  cwd: string;
  claudePid?: number;
  followActive: boolean;
  onView: (view: Mode) => void;
  onSessionEnd: () => void;
}): void {
  const { cwd, claudePid, followActive, onView, onSessionEnd } = opts;

  useEffect(() => {
    const started = Date.now();
    const control = watchFile(controlFile(cwd, claudePid), () => {
      const req = readControl(cwd, claudePid);
      if (req && req.at >= started) onView(req.view);
    });

    let timer: NodeJS.Timeout | undefined;
    const isEnded = () => {
      if (claudePid && !isAlive(claudePid)) return true;
      const a = claudePid ? readJson<ActiveSession>(claudeFile(cwd, claudePid)) : readActive(cwd);
      return !!a?.ended && Date.parse(a.updated) >= started;
    };
    const check = () => {
      if (!isEnded()) return;
      clearTimeout(timer);
      timer = setTimeout(() => isEnded() && onSessionEnd(), END_GRACE_MS);
    };
    const active = followActive ? watchFile(claudePid ? claudeFile(cwd, claudePid) : activeFile(cwd), check) : undefined;
    // Claude Code can exit without a SessionEnd hook (crash, closed window).
    const alive = followActive && claudePid ? setInterval(check, PROCESS_POLL_MS) : undefined;

    return () => {
      clearTimeout(timer);
      clearInterval(alive);
      void control.close();
      void active?.close();
    };
  }, [cwd, claudePid, followActive]);
}
