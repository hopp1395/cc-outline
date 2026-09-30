import { render } from "ink";
import { createElement, useState } from "react";
import type { Placement } from "./settings.js";
import { App } from "./tui/App.js";
import { frameBufferedStdout } from "./tui/frameBuffer.js";
import type { Mode } from "./tui/layout.js";
import type { ViewerAction } from "./viewer.js";

export interface WatchOptions {
  cwd: string;
  sessionId?: string;
  initialMode?: Mode;
  unfocused?: boolean;
  claudePid?: number;
  placement?: Placement;
  /** An entry to select in the start view (`releases` in Settings). */
  select?: string;
  /** Reopened after an update to this version. */
  updatedTo?: string;
  /** Started by /cco:update: check for an update at once and offer it. */
  action?: ViewerAction;
}

/**
 * The app for the viewer's current target. Pairing (Enter on a running session in Sessions,
 * for a viewer started without a Claude Code process) remounts it for that process and
 * its project, in the chat; the viewer stays where it runs.
 */
export function Viewer(opts: WatchOptions) {
  const [target, setTarget] = useState(opts);
  return createElement(App, {
    ...target,
    key: `${target.cwd}#${target.claudePid ?? ""}`,
    onPair: (cwd: string, claudePid: number) =>
      setTarget({ cwd, claudePid, placement: target.placement, initialMode: "chat" }),
  });
}

/**
 * Runs the viewer until it quits. Kept out of `cli.ts` and loaded only by
 * `cco watch`: Ink, React and the renderers take a second to load, and
 * `cco hook` runs on every prompt, before Claude Code writes it down.
 */
export async function runViewer(opts: WatchOptions): Promise<void> {
  const app = render(createElement(Viewer, opts), {
    // Only changed lines, in one write: no flicker under load. CCO_FRAME_BUFFER=0 turns it off.
    stdout: process.stdout.isTTY && process.env.CCO_FRAME_BUFFER !== "0" ? frameBufferedStdout(process.stdout) : process.stdout,
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
}
