import { render } from "ink";
import { createElement, useState } from "react";
import { setOwnSettings, setSessionViewer, type Placement } from "./settings.js";
import { App } from "./tui/App.js";
import { KeeperApp } from "./tui/KeeperApp.js";
import type { KeeperSelect } from "./keeper/registry.js";
import { withoutCtrlC } from "./tui/ctrlC.js";
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
  /** A remote viewer: the Remote Control session of this id, in the chat only. */
  remoteId?: string;
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
    // Detached, it follows the project's newest session and stays in the Sessions view it was detached from.
    onDetach: (cwd: string) => setTarget({ cwd, placement: target.placement, initialMode: "sessions" }),
  });
}

/**
 * Runs the viewer until it quits. Kept out of `cli.ts` and loaded only by
 * `cco watch`: Ink, React and the renderers take a second to load, and
 * `cco hook` runs on every prompt, before Claude Code writes it down.
 */
export async function runViewer(opts: WatchOptions): Promise<void> {
  // A viewer of one session shows its chat and its own settings, kept apart from the project's viewer's.
  if (opts.remoteId || opts.sessionId) setSessionViewer(true);
  await renderUntilExit(createElement(Viewer, opts));
}

/** Runs the keeper (`cco keeper`) until it quits: the sessions of every project and account, with its own settings. */
export async function runKeeper(opts: { unfocused?: boolean; select?: KeeperSelect } = {}): Promise<void> {
  setOwnSettings("keeper");
  await renderUntilExit(createElement(KeeperApp, opts));
}

async function renderUntilExit(element: ReturnType<typeof createElement>): Promise<void> {
  const app = render(element, {
    // Only changed lines, in one write: no flicker under load. CCO_FRAME_BUFFER=0 turns it off.
    stdout: process.stdout.isTTY && process.env.CCO_FRAME_BUFFER !== "0" ? frameBufferedStdout(process.stdout) : process.stdout,
    // Ctrl+C does not quit: copying out of habit closed the pane. The filter hands it to App instead.
    stdin: process.stdin.isTTY ? withoutCtrlC(process.stdin) : process.stdin,
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}
