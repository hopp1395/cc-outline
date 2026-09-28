import { render } from "ink";
import { createElement } from "react";
import type { Placement } from "./settings.js";
import { App } from "./tui/App.js";
import { frameBufferedStdout } from "./tui/frameBuffer.js";
import type { Mode } from "./tui/layout.js";

export interface WatchOptions {
  cwd: string;
  sessionId?: string;
  initialMode?: Mode;
  unfocused?: boolean;
  claudePid?: number;
  placement?: Placement;
}

/**
 * Runs the viewer until it quits. Kept out of `cli.ts` and loaded only by
 * `cco watch`: Ink, React and the renderers take a second to load, and
 * `cco hook` runs on every prompt, before Claude Code writes it down.
 */
export async function runViewer(opts: WatchOptions): Promise<void> {
  const app = render(createElement(App, opts), {
    // Only changed lines, in one write: no flicker under load. CCO_FRAME_BUFFER=0 turns it off.
    stdout: process.stdout.isTTY && process.env.CCO_FRAME_BUFFER !== "0" ? frameBufferedStdout(process.stdout) : process.stdout,
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
}
