import { useEffect } from "react";
import { activeFile, controlFile, readActive } from "../transcript/locate.js";
import { watchFile } from "../transcript/tail.js";
import { readControl } from "../viewer.js";
import type { Mode } from "./layout.js";

/** Grace period so a quick restart (end + start) doesn't close the viewer. */
const END_GRACE_MS = 1500;

/**
 * Wires the viewer to its surroundings: switches view on requests from
 * `cco open`, and exits when the followed Claude Code session ends.
 * Only changes after the viewer started count, so stale state is ignored.
 */
export function useViewerControl(opts: {
  cwd: string;
  followActive: boolean;
  onView: (view: Mode) => void;
  onSessionEnd: () => void;
}): void {
  const { cwd, followActive, onView, onSessionEnd } = opts;

  useEffect(() => {
    const started = Date.now();
    const control = watchFile(controlFile(cwd), () => {
      const req = readControl(cwd);
      if (req && req.at >= started) onView(req.view);
    });

    let timer: NodeJS.Timeout | undefined;
    const isEnded = () => {
      const a = readActive(cwd);
      return !!a?.ended && Date.parse(a.updated) >= started;
    };
    const active = followActive
      ? watchFile(activeFile(cwd), () => {
          if (!isEnded()) return;
          clearTimeout(timer);
          timer = setTimeout(() => isEnded() && onSessionEnd(), END_GRACE_MS);
        })
      : undefined;

    return () => {
      clearTimeout(timer);
      void control.close();
      void active?.close();
    };
  }, [cwd, followActive]);
}
